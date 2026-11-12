# adari-relay.pl: Adari's relay, one small process on the Mac that runs Herdr.
#
# The app sends this whole script with each SSH connection, as one exec on its
# command connection:
#   exec /usr/bin/perl -e "$(printf '%s' '<base64>' | /usr/bin/base64 -D)" -- "$SOCKET"
# Nothing is installed and nothing stays behind: the relay lives only as long
# as that channel. stdin and stdout carry newline-delimited JSON frames, one
# object per line (docs/relay.md); stderr is diagnostics only.
#
# It forwards Herdr requests to the Herdr socket named by its one argument (a
# new socket connection per request, all concurrent, replies verbatim), holds
# subscribe streams, answers ping, and reads or watches files inside $HOME
# (on request leaving long base64 runs out of the frames, with their offsets).
# It never writes a file, never runs a command and never opens a network
# socket. It exits when stdin ends or the client side of stdout closes, and on
# SIGHUP, SIGTERM or SIGINT. /usr/bin/perl 5.34, core modules only; one
# process, one IO::Select loop; stdout is never written while it is full.
use strict;
use warnings;
use IO::Socket::UNIX;
use IO::Select;
use JSON::PP;
use MIME::Base64 qw(encode_base64);
use Cwd qw(realpath);
use POSIX qw(EAGAIN EINTR ENOENT ELOOP);
use Fcntl qw(F_GETFL F_SETFL O_NONBLOCK O_RDONLY O_NOFOLLOW);
use Socket qw(MSG_PEEK);
use Time::HiRes qw(time);
use Encode qw(decode);

my $SOCKET      = $ARGV[0] // '';
my $MAX_LINE    = 1 << 20;     # a client line
my $MAX_REPLY   = 16 << 20;    # a Herdr reply or event line
my $MAX_READ    = 4 << 20;     # file bytes covered by one read frame
my $CHUNK       = 256 << 10;   # file bytes covered by one grew frame
my $MIN_OMIT    = 256;         # the smallest "omit" a read or watch takes
my $BACK        = 64;          # file bytes before a run that "omit" checks for a JSON escape
my $GAP         = 0.05;        # frames of one watch are at least this far apart
my $TICK        = 0.05;        # watched files are checked this often
my $EXPIRE      = 300;         # seconds before an unanswered request is retired
my $MAX_REQS    = 256;         # open requests
my $MAX_STREAMS = 32;          # open streams
my $MAX_WATCHES = 64;          # watches
my $HIGH        = 8 << 20;     # queued output above this pauses Herdr reads and watches
my $HARD        = 64 << 20;    # queued output above this ends the relay

my $json  = JSON::PP->new->utf8->canonical;
my $HOME  = $ENV{HOME} // '';
my $RHOME = $HOME ne '' ? realpath($HOME) : undef;

my $hsel = IO::Select->new;            # every Herdr connection, to read
my $wsel = IO::Select->new;            # Herdr connections with a request still to write
my (%conn, %req, %stream, %watch);     # by socket; by request id; by stream id; by watch id
my $nreq = 0;
my @oq;                         # queued output: whole frames, in order
my ($ooff, $oqbytes) = (0, 0);  # written bytes of the first; bytes queued

sub quit { exit 0 }
# SIGPIPE is ignored so a Herdr socket closing under a write fails only that
# request; a closed stdout is noticed by the hangup check or a failed write.
$SIG{HUP} = $SIG{TERM} = $SIG{INT} = \&quit;
$SIG{PIPE} = 'IGNORE';
binmode STDIN;
binmode STDOUT;
fcntl(STDOUT, F_SETFL, (fcntl(STDOUT, F_GETFL, 0) || 0) | O_NONBLOCK);

# The client side of stdout closing shows as stdout turning readable (a pipe's
# write end, or EOF on a socket). Watched only when stdout is a pipe or a
# socket of its own: a socket shared with stdin ends as stdin's EOF.
my @si = stat STDIN;
my @so = stat STDOUT;
my $out_watch = (-p STDOUT || -S STDOUT) && !(@si && $si[0] == $so[0] && $si[1] == $so[1]);

# The one writer: whole frames go on the queue and leave it in order, only when
# select says stdout can take more, so lines never interleave and a client
# that stops reading never blocks the loop.
sub emit {
  push @oq, $_[0];
  $oqbytes += length $_[0];
  return unless $oqbytes > $HARD;
  printf STDERR "adari-relay: over %d MiB of output queued, exiting\n", $HARD >> 20;
  quit();
}
sub frame { emit($json->encode($_[0]) . "\n") }
sub fail  { frame({relay => 'error', id => $_[0], code => $_[1], detail => $_[2]}) }

sub drain {
  while (@oq) {
    my $n = syswrite(STDOUT, $oq[0], length($oq[0]) - $ooff, $ooff);
    if (!defined $n) { return if $! == EAGAIN || $! == EINTR; quit() }
    $ooff += $n;
    $oqbytes -= $n;
    next if $ooff < length $oq[0];
    shift @oq;
    $ooff = 0;
  }
}

sub stdout_hangup {
  return quit() unless -S STDOUT;
  my $got = recv(STDOUT, my $b, 1, MSG_PEEK);
  if (defined $got) { return quit() unless length $b; $out_watch = 0; return }   # data: not ours to read
  quit() unless $! == EAGAIN || $! == EINTR;
}

# stdin ended: hand over what is queued (up to half a second), then go.
sub last_words {
  my $end = time + 0.5;
  my $s = IO::Select->new(\*STDOUT);
  while (@oq && (my $left = $end - time) > 0) { drain() if $s->can_write($left) }
  quit();
}

# ---- Herdr connections: one per request, one per stream ----

sub open_herdr {
  my ($id, $line, $kind) = @_;
  return fail($id, 'socket_missing', "no Herdr socket at '$SOCKET'")
    unless $SOCKET ne '' && -S $SOCKET;
  my $s = IO::Socket::UNIX->new(Type => SOCK_STREAM(), Peer => $SOCKET)
    or return fail($id, 'socket_failed', "connect: $!");
  $s->blocking(0);
  my $c = {sock => $s, id => $id, kind => $kind, out => "$line\n", in => '', t0 => time};
  $conn{$s} = $c;
  if ($kind eq 'stream') { $stream{$id} = $c } else { $req{$id} = $c; $nreq++ }
  $hsel->add($s);
  $wsel->add($s);
}

# Closes a connection; a stream the client did not close reports `ended`.
sub finish {
  my ($c, $quiet) = @_;
  my $s = $c->{sock};
  return unless $conn{$s};
  $hsel->remove($s);
  $wsel->remove($s);
  delete $conn{$s};
  close $s;
  my $by = $c->{kind} eq 'stream' ? \%stream : \%req;
  delete $by->{$c->{id}} if ($by->{$c->{id}} // 0) == $c;
  if ($c->{kind} eq 'req') { $nreq--; return }
  frame({relay => 'ended', id => $c->{id}}) unless $quiet;
}

sub herdr_writable {
  my $c = shift;
  my $n = syswrite($c->{sock}, $c->{out});
  if (defined $n) {
    substr($c->{out}, 0, $n, '');
    $wsel->remove($c->{sock}) unless length $c->{out};
  } elsif ($! != EAGAIN && $! != EINTR) {
    fail($c->{id}, 'socket_failed', "write: $!");
    finish($c);
  }
}

# One whole line from Herdr; returns 1 when the connection is done.
sub herdr_line {
  my ($c, $line) = @_;
  if (length $line > $MAX_REPLY) {
    fail($c->{id}, 'too_large', 'a Herdr line over 16 MiB');
    finish($c);
    return 1;
  }
  return 0 unless length $line;
  if ($c->{kind} eq 'req') { emit("$line\n"); finish($c); return 1 }
  frame({relay => 'event', id => $c->{id}, data => decode('UTF-8', $line)});
  return 0;
}

sub herdr_readable {
  my $c = shift;
  my $n = sysread($c->{sock}, my $buf, 1 << 16);
  if (!defined $n) {
    return if $! == EAGAIN || $! == EINTR;
    fail($c->{id}, 'socket_failed', "read: $!");
    return finish($c);
  }
  if ($n == 0) {   # Herdr closed: a last unterminated line still counts
    return if length $c->{in} && herdr_line($c, $c->{in});
    fail($c->{id}, 'socket_failed', 'Herdr closed without a reply') if $c->{kind} eq 'req';
    return finish($c);
  }
  $c->{in} .= $buf;
  while ((my $i = index($c->{in}, "\n")) >= 0) {
    my $line = substr($c->{in}, 0, $i + 1, '');
    chop $line;
    return if herdr_line($c, $line);
  }
  if (length $c->{in} > $MAX_REPLY) {
    fail($c->{id}, 'too_large', 'a Herdr line over 16 MiB');
    finish($c);
  }
}

# ---- Files: read and watch, regular files inside $HOME only ----

# Returns (real path, undef, dev, ino), or (undef, 'gone' or 'refused_path').
sub resolve {
  my $p = shift;
  return (undef, 'refused_path') unless defined $p && !ref $p && length $p && defined $RHOME;
  $p = "$HOME/" . substr($p, 2) if substr($p, 0, 2) eq '~/';
  $p = "$HOME/$p" unless substr($p, 0, 1) eq '/';
  my $r = realpath($p);
  my $inside = defined $r ? index($r, "$RHOME/") == 0
                          : index($p, "$HOME/") == 0 && $p !~ m{/\.\.(/|$)};
  return (undef, 'refused_path') unless $inside;
  my @st = defined $r ? stat $r : ();
  return (undef, 'gone') unless @st;
  return (undef, 'refused_path') unless -f _;
  return ($r, undef, @st[0, 1]);
}

# Opens a path read-only once it is validated: no last symlink followed, no
# wait on a FIFO, and the open descriptor must be the very regular file the
# validation saw (same device and inode), so a file or folder swapped in
# between is refused. Returns (handle, [stat], real path) or (undef, why, detail).
sub open_checked {
  my ($r, $why, @want) = resolve(shift);
  return (undef, $why, 'not a regular file inside $HOME') unless defined $r;
  # relay-test: barrier
  sysopen(my $fh, $r, O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
    or return (undef, $! == ENOENT ? 'gone' : $! == ELOOP ? 'refused_path' : 'io', "open: $!");
  my @st = stat $fh;
  return (undef, 'refused_path', 'the file changed while it was opened')
    unless @st && -f _ && $st[0] == $want[0] && $st[1] == $want[1];
  return ($fh, \@st, $r);
}

sub whole { defined $_[0] && !ref $_[0] && $_[0] =~ /^\d+$/ }

# A failed open answers gone or an error, for read and for a new watch.
sub refuse { $_[1] eq 'gone' ? frame({relay => 'gone', id => $_[0]}) : fail(@_) }

# "omit" and "tail" (contract v1.2) take ASCII digits only, no sign, point or
# trailing newline; offset and max keep whole() above, as in v1.1.
sub digits { defined $_[0] && !ref $_[0] && $_[0] =~ /\A[0-9]+\z/ }

# A frame's "omit": absent or null is none; anything but a whole number of at
# least $MIN_OMIT is a bad frame.
sub bad_omit { defined $_[0] && !(digits($_[0]) && $_[0] >= $MIN_OMIT) }

# True when the run at $_[1] of the frame bytes $_[0] (file offset $_[2],
# after the file bytes $_[3]) would begin inside a JSON escape, judged on the
# $BACK file bytes before it: after an odd number of backslashes (the run
# starts at the escape's letter, as in \n or \/), or after an escaping \u and
# fewer than four hex digits (a frame that starts inside \u00e9). Backslashes
# that fill all $BACK bytes count as escaping: their number is not known. A
# run inside the frame follows a byte outside the alphabet, so only a
# backslash there, or a run at the frame's start, needs the look back.
sub in_escape {
  my ($p, $at) = @_[1, 2];
  return 0 if $p && substr($_[0], $p - 1, 1) ne '\\';
  my $s = $p >= $BACK ? substr($_[0], $p - $BACK, $BACK) : substr($_[3] . substr($_[0], 0, $p), -$BACK);
  my $whole = $at + $p == length $s;   # the bytes looked at go back to the file's start
  $s =~ s/u[0-9A-Fa-f]{0,3}\z//;
  my $n = length $s;
  $s =~ s/\\+\z//;
  $n -= length $s;
  return $n % 2 || ($n && !length $s && !$whole);
}

# Leaves out of $_[0], file bytes from offset $_[1], every run of at least
# $_[2] bytes drawn only from [A-Za-z0-9+/=] (a run cut by either end is
# judged on the part inside), except a run that would begin inside a JSON
# escape (in_escape; $_[3] holds up to $BACK file bytes before $_[0]), which
# stays whole: returns (the kept bytes, [[file offset, length], ...]
# ascending). One pass over a copy with every other byte turned into NUL:
# from a run's possible start $p, rindex finds the last NUL among the next
# $MIN_OMIT bytes and the walk goes on after it (text: a stride of about
# $MIN_OMIT); none means a run starts at $p, matched to its end. Linear: any
# two steps in a row move on more than $MIN_OMIT bytes, a rindex looks at
# $MIN_OMIT bytes at most, and a run's bytes are matched once.
sub omit_runs {
  my ($at, $k) = @_[1, 2];
  (my $m = $_[0]) =~ tr{A-Za-z0-9+/=}{\0}c;
  my ($p, $from, $kept, @om) = (0, 0, '');
  while ($p + $MIN_OMIT <= length $m) {
    my $q = rindex($m, "\0", $p + $MIN_OMIT - 1);
    if ($q >= $p) { $p = $q + 1; next }
    pos($m) = $p;
    $m =~ /\G[^\0]+/g;
    my $e = pos $m;
    if ($e - $p >= $k && !in_escape($_[0], $p, $at, $_[3])) {
      $kept .= substr($_[0], $from, $p - $from);
      push @om, [$at + $p, $e - $p];
      $from = $e;
    }
    $p = $e;
  }
  return ($kept . substr($_[0], $from), \@om);
}

# "tail":M reads from max(0, size - M), max defaulting to M; "omit":K leaves
# the long base64 runs out (omit_runs) and lists them in "omitted".
sub do_read {
  my ($id, $f) = @_;
  my ($tail, $k) = @$f{qw(tail omit)};
  if (defined $tail) {
    return fail($id, 'bad_frame', 'tail and offset do not go together') if defined $f->{offset};
    return fail($id, 'bad_frame', 'tail is a whole number') unless digits($tail);
  }
  return fail($id, 'bad_frame', "omit is a whole number of at least $MIN_OMIT") if bad_omit($k);
  my ($off, $max) = ($f->{offset} // 0, $f->{max} // $tail // $MAX_READ);
  return fail($id, 'bad_frame', 'offset and max are whole numbers') unless whole($off) && whole($max);
  my ($fh, $st, $detail) = open_checked($f->{path});
  return refuse($id, $st, $detail) unless $fh;
  $off = $st->[7] > $tail ? $st->[7] - $tail : 0 if defined $tail;
  my ($data, $before) = ('', '');
  if ($off < $st->[7] && $max > 0) {
    my $back = defined $k ? ($off < $BACK ? $off : $BACK) : 0;   # with omit, the bytes before too
    sysseek($fh, $off - $back, 0) && defined sysread($fh, $data, $back + ($max > $MAX_READ ? $MAX_READ : $max))
      or return fail($id, 'io', "read: $!");
    $before = substr($data, 0, $back, '');
  }
  my %r = (relay => 'read', id => $id, size => $st->[7], ino => $st->[1], offset => $off + 0);
  ($data, $r{omitted}) = omit_runs($data, $off + 0, $k, $before) if defined $k;
  frame({%r, data => encode_base64($data, '')});
}

sub do_watch {
  my ($id, $f) = @_;
  my ($off, $k) = ($f->{offset} // 0, $f->{omit});
  return fail($id, 'bad_frame', 'offset is a whole number') unless whole($off);
  return fail($id, 'bad_frame', "omit is a whole number of at least $MIN_OMIT") if bad_omit($k);
  return fail($id, 'bad_frame', 'this watch id is in use') if $watch{$id};
  return fail($id, 'limit', "$MAX_WATCHES watches open") if keys %watch >= $MAX_WATCHES;
  my ($fh, $st, $r) = open_checked($f->{path});
  return refuse($id, $st, $r) unless $fh;
  $watch{$id} = {id => $id, path => $r, fh => $fh, ino => $st->[1], size => $st->[7], pos => $off + 0, next => 0,
                 omit => $k};
}

# One check of one watch: gone, reset (it shrank below the last size seen, or
# a new inode), or the growth from the last position, at most $CHUNK bytes and
# one frame per $GAP (with "omit", each frame judged on its own bytes). After
# a reset the watch carries on from the new size.
sub check_watch {
  my ($w, $now) = @_;
  return if $now < $w->{next};
  my @st = stat $w->{path};
  if (!@st || !-f _) { delete $watch{$w->{id}}; return frame({relay => 'gone', id => $w->{id}}) }
  if ($st[1] != $w->{ino} || $st[7] < $w->{size} || $st[7] < $w->{pos}) {
    if ($st[1] != $w->{ino}) {
      my ($fh, $s) = open_checked($w->{path});
      unless ($fh) { delete $watch{$w->{id}}; return frame({relay => 'gone', id => $w->{id}}) }
      @st = @$s;
      @$w{qw(fh ino)} = ($fh, $st[1]);
    }
    @$w{qw(pos size next)} = ($st[7], $st[7], $now + $GAP);
    return frame({relay => 'reset', id => $w->{id}, size => $st[7], ino => $st[1]});
  }
  $w->{size} = $st[7];
  return unless $st[7] > $w->{pos};
  my $want = $st[7] - $w->{pos};
  $want = $CHUNK if $want > $CHUNK;
  my $back = defined $w->{omit} ? ($w->{pos} < $BACK ? $w->{pos} : $BACK) : 0;
  my $data = '';
  unless (sysseek($w->{fh}, $w->{pos} - $back, 0) && defined sysread($w->{fh}, $data, $back + $want)) {
    delete $watch{$w->{id}};
    return fail($w->{id}, 'io', "read: $!");
  }
  my $before = substr($data, 0, $back, '');
  my $covered = length $data or return;
  my %g = (relay => 'grew', id => $w->{id}, offset => $w->{pos}, size => $st[7]);
  ($data, $g{omitted}) = omit_runs($data, $w->{pos}, $w->{omit}, $before) if defined $w->{omit};
  frame({%g, data => encode_base64($data, '')});
  $w->{pos} += $covered;
  $w->{next} = $now + $GAP;
}

# ---- Client frames ----

sub client_line {
  my $line = shift;
  return unless $line =~ /\S/;
  my $f = eval { $json->decode($line) };
  return fail(undef, 'bad_frame', 'not a JSON object') unless ref $f eq 'HASH';
  my ($id, $verb) = ($f->{id}, $f->{relay});
  return fail(undef, 'bad_frame', 'a frame needs an "id"') unless defined $id && !ref $id;
  unless (defined $verb) {   # a Herdr request, verbatim
    return fail($id, 'limit', "$MAX_REQS requests open") if $nreq >= $MAX_REQS;
    return open_herdr($id, $line, 'req');
  }
  if ($verb eq 'ping') { frame({relay => 'pong', id => $id}) }
  elsif ($verb eq 'stream') {
    return fail($id, 'bad_frame', 'a stream needs a "request" object') unless ref $f->{request} eq 'HASH';
    return fail($id, 'bad_frame', 'this stream id is in use') if $stream{$id};
    return fail($id, 'limit', "$MAX_STREAMS streams open") if keys %stream >= $MAX_STREAMS;
    open_herdr($id, $json->encode($f->{request}), 'stream');
  }
  elsif ($verb eq 'close')   { my $c = $stream{$id}; finish($c, 1) if $c }
  elsif ($verb eq 'cancel')  { my $c = $req{$id}; finish($c, 1) if $c }
  elsif ($verb eq 'read')    { do_read($id, $f) }
  elsif ($verb eq 'watch')   { do_watch($id, $f) }
  elsif ($verb eq 'unwatch') { delete $watch{$id} }
  else { fail($id, 'bad_frame', 'unknown relay frame') }
}

my ($inbuf, $skipping) = ('', 0);

# The id of a line too long to parse, best effort (null when not found early).
sub guess_id {
  return $_[0] =~ /^\s*\{[^{]*?"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/
    ? eval { JSON::PP->new->allow_nonref->decode($1) } : undef;
}

sub stdin_readable {
  my $n = sysread(STDIN, my $buf, 1 << 16);
  if (!defined $n) { return if $! == EAGAIN || $! == EINTR; quit() }
  last_words() if $n == 0;
  $inbuf .= $buf;
  while (1) {
    my $i = index($inbuf, "\n");
    if ($i < 0) {
      if (length $inbuf > $MAX_LINE) { $skipping = [guess_id($inbuf)] unless $skipping; $inbuf = '' }
      last;
    }
    my $line = substr($inbuf, 0, $i + 1, '');
    chop $line;
    if ($skipping || length $line > $MAX_LINE) {
      fail($skipping ? $skipping->[0] : guess_id($line), 'too_large', 'a line over 1 MiB, dropped');
      $skipping = 0;
      next;
    }
    client_line($line);
  }
}

# Retires requests Herdr has not answered in $EXPIRE seconds.
sub expire {
  my $now = shift;
  for my $c (grep { $_->{kind} eq 'req' && $now - $_->{t0} >= $EXPIRE } values %conn) {
    fail($c->{id}, 'expired', "no reply in $EXPIRE s");
    finish($c);
  }
}

# ---- The loop ----

frame({relay => 'hello', v => 1});
my ($next_tick, $next_house) = (time + $TICK, time + 1);
while (1) {
  my $paused = $oqbytes > $HIGH;   # the client is behind: stop producing, keep listening
  my $due = %watch && !$paused && $next_tick < $next_house ? $next_tick : $next_house;
  my $wait = $due - time;
  $wait = 0 if $wait < 0;
  my $rs = IO::Select->new(\*STDIN, $out_watch ? \*STDOUT : (), $paused ? () : $hsel->handles);
  my $ws = IO::Select->new($wsel->handles, @oq ? \*STDOUT : ());
  my ($r, $w) = IO::Select->select($rs, $ws->count ? $ws : undef, undef, $wait);
  for my $h (@{$w || []}) {
    if ($h eq \*STDOUT) { drain() }
    elsif (my $c = $conn{$h}) { herdr_writable($c) }
  }
  for my $h (@{$r || []}) {
    if ($h eq \*STDIN) { stdin_readable() }
    elsif ($h eq \*STDOUT) { stdout_hangup() }
    elsif (my $c = $conn{$h}) { herdr_readable($c) unless $oqbytes > $HIGH }
  }
  my $now = time;
  if ($now >= $next_tick) {
    for my $w (grep { defined } map { $watch{$_} } sort keys %watch) {
      last if $oqbytes > $HIGH;
      check_watch($w, $now);
    }
    $next_tick = $now + $TICK;
  }
  if ($now >= $next_house) { expire($now); $next_house = $now + 1 }
}
