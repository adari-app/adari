# fake-herdr.pl SOCKET LOG [method=seconds,...]
#
# A stand-in for Herdr's API socket, for the relay tests only: a Unix socket
# server that, like Herdr, answers one request line per connection. Each
# connection is served by its own child, so slow methods do not hold up fast
# ones. It appends one line per event to LOG ("conn METHOD ID", "peer-closed
# ID") so the tests can count connections and see a client close.
#
# Methods: any method gets an echo reply (fixed odd spacing, so "verbatim" is
# checkable), after the delay named for it on the command line. Special ones:
#   big        a 2 MiB reply line
#   noreply    closes without answering
#   hang       never answers; logs "peer-closed ID" when the relay closes it
#   sized      params {bytes, split, nl_alone}: one line of exactly `bytes`
#              bytes, written as the first `split` bytes, a pause, the rest
#              and the newline (with nl_alone, the newline after one more
#              pause, so it comes in a read of its own); then closes
#   subscribe  params {count, every, hold}: count event lines, `every` seconds
#              apart, then closes; with hold, keeps sending until the peer
#              closes. With params {kind, pane} (the apps' integration
#              tests): Herdr's subscription_started reply first, then
#              `count` event lines {"event":KIND,"data":{"pane_id":PANE}},
#              then it stays open, quiet, until the peer closes.
use strict;
use warnings;
use IO::Socket::UNIX;
use JSON::PP;
use Time::HiRes qw(sleep);

my ($path, $log, $delays) = @ARGV;
my %delay = map { split /=/, $_, 2 } grep { length } split /,/, ($delays // '');
setpgrp(0, 0);
$SIG{CHLD} = 'IGNORE';
$SIG{PIPE} = 'IGNORE';
my $server = IO::Socket::UNIX->new(Type => SOCK_STREAM(), Local => $path, Listen => 128)
  or die "fake-herdr: listen on $path: $!\n";

sub note {
  open(my $fh, '>>', $log) or return;
  syswrite($fh, "$_[0]\n");
}

sub serve {
  my $c = shift;
  my $line = <$c>;
  return unless defined $line;
  chomp $line;
  my $req = eval { JSON::PP->new->decode($line) } || {};
  my ($id, $method) = ($req->{id} // '', $req->{method} // '');
  note("conn $method $id");
  sleep($delay{$method}) if $delay{$method};
  my $idj = JSON::PP->new->allow_nonref->encode($id);
  return if $method eq 'noreply';
  if ($method eq 'hang') { 1 while sysread($c, my $b, 4096); note("peer-closed $id"); return }
  if ($method eq 'sized') {
    my $p = $req->{params} || {};
    my $head = qq({"id":$idj,"result":");
    my $line = $head . ('x' x ($p->{bytes} - length($head) - 2)) . '"}';
    my $split = $p->{split} // length $line;
    $c->autoflush(1);
    print $c substr($line, 0, $split);
    sleep 0.15;
    print $c substr($line, $split);
    sleep 0.15 if $p->{nl_alone};
    print $c "\n";
    return;
  }
  if ($method eq 'big') {
    print $c qq({"id":$idj,"result":{"blob":"), 'x' x (2 << 20), qq("}}\n);
    return;
  }
  if ($method eq 'subscribe') {
    my $p = $req->{params} || {};
    my ($count, $every, $hold) = ($p->{count} // 3, $p->{every} // 0.01, $p->{hold});
    my $kind = $p->{kind};
    $c->autoflush(1);
    if (defined $kind) {
      my $j = JSON::PP->new->canonical;
      print $c $j->encode({id => $id, result => {type => 'subscription_started'}}), "\n";
      $kind = $j->encode({event => $kind, data => {pane_id => $p->{pane} // 'w1:p1'}});
    }
    for (my $i = 1; $i <= $count || $hold; $i++) {
      my $line = defined $kind ? "$kind\n" : qq({"event":$i, "sub":$idj, "text":"caf\x{c3}\x{a9}"}\n);
      unless (print $c $line) { note("peer-closed $id"); return }
      sleep($every);
    }
    if (defined $kind) { 1 while sysread($c, my $b, 4096); note("peer-closed $id") }
    return;
  }
  print $c qq({"id":$idj,  "result" : {"method":"$method","text":"caf\x{c3}\x{a9} \\u00e9"}}\n);
}

$SIG{TERM} = sub { exit 0 };
while (1) {
  my $c = $server->accept or next;
  my $pid = fork;
  next unless defined $pid;
  if ($pid == 0) { close $server; serve($c); close $c; exit 0 }
  close $c;
}
