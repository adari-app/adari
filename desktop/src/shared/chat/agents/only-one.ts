// A session a reported id names is that one file, or
// none. A locate command whose loop gathered the regular files an id's globs match into "$@" ends with this text:
// it prints the one file (the same file reached twice, through a link, counts once) and prints nothing when two
// distinct files hold the id, so a copied or migrated session is never chosen by its modification time (the
// pane's Chat says the session is not found). Imports nothing.

/** `/bin/sh` text: "$1" when every argument is the same file as it, else nothing; exits 0. */
export const onlyOneFile = '[ "$#" -gt 0 ] && { o=$1; for g in "$@"; do [ "$g" -ef "$o" ] || exit 0; done; printf \'%s\\n\' "$o"; }; exit 0';
