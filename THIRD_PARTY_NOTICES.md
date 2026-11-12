# Third-party notices: the iPhone and iPad app

This file lists the third-party software in the Adari iPhone and iPad app (`App/`,
`Sources/`, `Vendor/`), with its licences. That app's source, with the `Vendor/`,
`Package.resolved` and `project.yml` named below, comes with that app. The Mac app has its own
list in [desktop/THIRD_PARTY_NOTICES.md](desktop/THIRD_PARTY_NOTICES.md). Adari's own licence
is in [LICENSE](LICENSE), and the Herdrup derivation is described in [NOTICE](NOTICE).

Versions are the ones pinned in `Package.resolved` and `project.yml`. Components inside the
libghostty binary are those its build lists and the binary contains (see the table notes).

## Summary

| Component | Version | Licence | Where it comes from |
|---|---|---|---|
| Herdrup (the baseline Adari was derived from) | commit 93c6578 | Apache-2.0 | [NOTICE](NOTICE) |
| swift-nio-ssh (vendored fork, modified) | 0.3.6 (Wellz26 fork, a05e6bb) plus one upstream fix | Apache-2.0 | `Vendor/swift-nio-ssh` |
| Citadel | 0.12.1 | MIT | Swift package |
| BigInt | 5.7.0 | MIT | Swift package |
| swift-nio | 2.101.3 | Apache-2.0 | Swift package |
| swift-crypto (includes BoringSSL) | 3.15.1 | Apache-2.0 | Swift package |
| swift-log | 1.14.0 | Apache-2.0 | Swift package |
| swift-atomics | 1.3.1 | Apache-2.0 | Swift package |
| swift-collections | 1.6.0 | Apache-2.0 | Swift package |
| swift-asn1 | 1.7.1 | Apache-2.0 | Swift package |
| swift-system | 1.7.5 | Apache-2.0 | Swift package |
| libghostty-spm (GhosttyTerminal) | revision 42bacd1 (2.2.2026101502) | MIT | Swift package |
| DisplayLink | 3.0.1 | MIT | Swift package |
| Ghostty (libghostty) | 1e9e14a | MIT | binary inside libghostty-spm |
| FreeType | in libghostty | FreeType License (FTL) | in libghostty |
| Oniguruma | in libghostty | BSD-2-Clause | in libghostty |
| simdutf | in libghostty | MIT (or Apache-2.0) | in libghostty |
| Highway | in libghostty | Apache-2.0 (or BSD-3-Clause) | in libghostty |
| libpng | in libghostty | PNG Reference Library License v2 | in libghostty |
| zlib | in libghostty | zlib | in libghostty |
| Wuffs | in libghostty | MIT (or Apache-2.0) | in libghostty |
| libxev | in libghostty | MIT | in libghostty |
| uucode | in libghostty | MIT | in libghostty |
| zig-objc | in libghostty | MIT | in libghostty (Ghostty's build) |
| zf, libvaxis | in Ghostty's build | MIT | listed by Ghostty's build; see note 2 |
| stb | in libghostty | MIT (or public domain) | in libghostty |
| Zig standard library | in libghostty | MIT | in libghostty |
| z2d | commit 7dbae85c | MPL-2.0 | in libghostty |
| JetBrains Mono (in libghostty) | 2.304 | SIL OFL 1.1 | font embedded in libghostty |
| Symbols Nerd Font (in libghostty) | 3.4.0 | MIT; glyphs under their own licences (note 3) | font embedded in libghostty |
| bash-preexec | in GhosttyTerminal's resources | MIT | `shell-integration/bash` in the package |
| Geist | | SIL OFL 1.1 | `App/Fonts/Geist-OFL.txt` |
| IBM Plex Mono | | SIL OFL 1.1 | `App/Fonts/IBMPlexMono-OFL.txt` |
| JetBrains Mono (app font) | | SIL OFL 1.1 | `App/Fonts/JetBrainsMono-OFL.txt` |

Notes:

1. The Ghostty commit and its dependency list are from libghostty-spm's `Ghostty.ref` and
   Ghostty's `build.zig.zon` at that commit. FreeType, Oniguruma, simdutf, Highway, libpng,
   zlib, Wuffs, libxev, uucode, stb, JetBrains Mono and Symbols Nerd Font were also found in
   the iOS `libghostty.a` itself. z2d leaves no name in the binary; it is in Ghostty's build at
   the commit named above.
2. zf and libvaxis are in Ghostty's build and in the app's credits, but were not found in the
   binary. They are listed here to be safe.
3. Symbols Nerd Font is distributed by the Nerd Fonts project, whose licence says its own files
   are MIT and that the icon glyphs come from several sources under their own licences (SIL OFL
   1.1, MIT and others; see https://github.com/ryanoasis/nerd-fonts/blob/master/LICENSE).

## Apache License 2.0

Herdrup, the vendored swift-nio-ssh, swift-nio, swift-crypto (including BoringSSL, whose files
in this version carry Apache-2.0 headers), swift-log, swift-atomics, swift-collections,
swift-asn1 and swift-system are licensed under the Apache License, Version 2.0. Its text is in
[LICENSE](LICENSE), and also in `Vendor/swift-nio-ssh/LICENSE.txt`. swift-nio and swift-crypto
carry a `NOTICE.txt` in their repositories, which lists further components they include.
Highway, simdutf and Wuffs are also offered under Apache-2.0.

## MIT License

Each of the following is licensed under the MIT License, with the copyright notice shown and
the permission notice below.

- Citadel: Copyright (c) 2022 Orlandos
- BigInt: Copyright (c) 2016-2017 Károly Lőrentey
- libghostty-spm: Copyright (c) 2026 @Lakr233
- DisplayLink: Copyright (c) 2024 Lakr Aream
- Ghostty: Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors
- libxev: Copyright (c) 2023 Mitchell Hashimoto
- zig-objc: Copyright (c) 2023 Mitchell Hashimoto
- uucode: Copyright (c) 2026 Jacob Sandlund
- zf: Copyright (c) Nathan Craddock
- libvaxis: Copyright (c) 2023 Tim Culverhouse
- Zig standard library: Copyright (c) Zig contributors
- stb: Copyright (c) 2017 Sean Barrett
- simdutf: Copyright 2021 The simdutf authors
- Wuffs: Copyright 2023 The Wuffs Authors
- Symbols Nerd Font (Nerd Fonts): Copyright (c) 2014 Ryan L McIntyre
- bash-preexec: Copyright (c) 2017 Ryan Caloras and contributors

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Oniguruma (BSD-2-Clause)

```
Oniguruma LICENSE
-----------------

Copyright (c) 2002-2021  K.Kosako  <kkosako0@gmail.com>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS ``AS IS'' AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
SUCH DAMAGE.
```

## zlib

```
Copyright notice:

 (C) 1995-2026 Jean-loup Gailly and Mark Adler

  This software is provided 'as-is', without any express or implied
  warranty.  In no event will the authors be held liable for any damages
  arising from the use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
     claim that you wrote the original software. If you use this software
     in a product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.

  Jean-loup Gailly        Mark Adler
  jloup@gzip.org          madler@alumni.caltech.edu
```

## libpng

```
COPYRIGHT NOTICE, DISCLAIMER, and LICENSE
=========================================

PNG Reference Library License version 2
---------------------------------------

 * Copyright (c) 1995-2026 The PNG Reference Library Authors.
 * Copyright (c) 2018-2026 Cosmin Truta.
 * Copyright (c) 2000-2002, 2004, 2006-2018 Glenn Randers-Pehrson.
 * Copyright (c) 1996-1997 Andreas Dilger.
 * Copyright (c) 1995-1996 Guy Eric Schalnat, Group 42, Inc.

The software is supplied "as is", without warranty of any kind,
express or implied, including, without limitation, the warranties
of merchantability, fitness for a particular purpose, title, and
non-infringement.  In no event shall the Copyright owners, or
anyone distributing the software, be liable for any damages or
other liability, whether in contract, tort or otherwise, arising
from, out of, or in connection with the software, or the use or
other dealings in the software, even if advised of the possibility
of such damage.

Permission is hereby granted to use, copy, modify, and distribute
this software, or portions hereof, for any purpose, without fee,
subject to the following restrictions:

 1. The origin of this software must not be misrepresented; you
    must not claim that you wrote the original software.  If you
    use this software in a product, an acknowledgment in the product
    documentation would be appreciated, but is not required.

 2. Altered source versions must be plainly marked as such, and must
    not be misrepresented as being the original software.

 3. This Copyright notice may not be removed or altered from any
    source or altered source distribution.


PNG Reference Library License version 1 (for libpng 0.5 through 1.6.35)
-----------------------------------------------------------------------

libpng versions 1.0.7, July 1, 2000, through 1.6.35, July 15, 2018 are
Copyright (c) 2000-2002, 2004, 2006-2018 Glenn Randers-Pehrson, are
derived from libpng-1.0.6, and are distributed according to the same
disclaimer and license as libpng-1.0.6 with the following individuals
added to the list of Contributing Authors:

    Simon-Pierre Cadieux
    Eric S. Raymond
    Mans Rullgard
    Cosmin Truta
    Gilles Vollant
    James Yu
    Mandar Sahastrabuddhe
    Google Inc.
    Vadim Barkov

and with the following additions to the disclaimer:

    There is no warranty against interference with your enjoyment of
    the library or against infringement.  There is no warranty that our
    efforts or the library will fulfill any of your particular purposes
    or needs.  This library is provided with all faults, and the entire
    risk of satisfactory quality, performance, accuracy, and effort is
    with the user.

Some files in the "contrib" directory and some configure-generated
files that are distributed with libpng have other copyright owners, and
are released under other open source licenses.

libpng versions 0.97, January 1998, through 1.0.6, March 20, 2000, are
Copyright (c) 1998-2000 Glenn Randers-Pehrson, are derived from
libpng-0.96, and are distributed according to the same disclaimer and
license as libpng-0.96, with the following individuals added to the
list of Contributing Authors:

    Tom Lane
    Glenn Randers-Pehrson
    Willem van Schaik

libpng versions 0.89, June 1996, through 0.96, May 1997, are
Copyright (c) 1996-1997 Andreas Dilger, are derived from libpng-0.88,
and are distributed according to the same disclaimer and license as
libpng-0.88, with the following individuals added to the list of
Contributing Authors:

    John Bowler
    Kevin Bracey
    Sam Bushell
    Magnus Holmgren
    Greg Roelofs
    Tom Tanner

Some files in the "scripts" directory have other copyright owners,
but are released under this license.

libpng versions 0.5, May 1995, through 0.88, January 1996, are
Copyright (c) 1995-1996 Guy Eric Schalnat, Group 42, Inc.

For the purposes of this copyright and license, "Contributing Authors"
is defined as the following set of individuals:

    Andreas Dilger
    Dave Martindale
    Guy Eric Schalnat
    Paul Schmidt
    Tim Wegner

The PNG Reference Library is supplied "AS IS".  The Contributing
Authors and Group 42, Inc. disclaim all warranties, expressed or
implied, including, without limitation, the warranties of
merchantability and of fitness for any purpose.  The Contributing
Authors and Group 42, Inc. assume no liability for direct, indirect,
incidental, special, exemplary, or consequential damages, which may
result from the use of the PNG Reference Library, even if advised of
the possibility of such damage.

Permission is hereby granted to use, copy, modify, and distribute this
source code, or portions hereof, for any purpose, without fee, subject
to the following restrictions:

 1. The origin of this source code must not be misrepresented.

 2. Altered versions must be plainly marked as such and must not
    be misrepresented as being the original source.

 3. This Copyright notice may not be removed or altered from any
    source or altered source distribution.

The Contributing Authors and Group 42, Inc. specifically permit,
without fee, and encourage the use of this source code as a component
to supporting the PNG file format in commercial products.  If you use
this source code in a product, acknowledgment is not required but would
be appreciated.
```

## FreeType

Portions of this software are copyright © The FreeType Project (www.freetype.org). All rights
reserved.

FreeType is used under the FreeType License (FTL), one of its two licences (see
https://gitlab.freedesktop.org/freetype/freetype/-/blob/master/docs/FTL.TXT).

## z2d (MPL-2.0)

z2d is Copyright © 2024-2026 Chris Marchesi and subject to the terms of the Mozilla Public
License, v. 2.0 (https://mozilla.org/MPL/2.0/). It is compiled, unchanged, into libghostty. Its
source is at https://github.com/vancluever/z2d, commit 7dbae85c81784dba9988320bf9543ed9a81350c8.

## Fonts (SIL Open Font License 1.1)

Geist, IBM Plex Mono and JetBrains Mono are bundled in `App/Fonts/`, each with its licence
(`Geist-OFL.txt`, `IBMPlexMono-OFL.txt`, `JetBrainsMono-OFL.txt`). libghostty embeds its own
copy of JetBrains Mono (2.304) under the same licence.
