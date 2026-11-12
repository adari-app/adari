// Command-line flags. Everything is off unless asked for.
//
//   --demo                     a fake Herdr from the repo's fixtures: two demo hosts, no network
//   --capture=<dir>            demo captures: the window's own pixels (webContents.capturePage)
//                              written to <dir>, shown without taking focus; implies --demo
//   --capture-quit             quit after the captures
//   --capture-only=<a,b>       only the captures whose names start with one of these
//                              (e.g. 106,107 or 10 for 100-109); every capture when absent
//   --window-size=<w>x<h>      initial window size
//   --herdr-user-data=<dir>    a separate userData folder (hosts.json, known_hosts.json)
//   --look-probe=<dir>         scroll and box-growth probe (look-probe.ts) written to <dir>,
//                              after the captures if any; implies --demo
//   --flicker-probe=<dir>      the message box's flicker probe (flicker-probe.ts) written to
//                              <dir>, then quit; implies --demo; ignored in the packaged app
//   --splits-probe=<file>      the frame probe: the demo's split tab timed,
//                              the numbers written to <file> as JSON, then quit; implies --demo
//   --showcase                 the showcase: demo mode with its own invented setup
//                              (src/main/showcase) in place of the recorded fixtures; implies --demo
//   --showcase-capture=<dir>   the showcase shots: 1600x900 at 2x, each shot, a 12 s clip, written to
//                              <dir>, shown without taking focus, then quit; implies --showcase
//
// In the packaged app (and in any build made without the demo, see main.ts) the demo, capture,
// look-probe, splits-probe, showcase and showcase-capture flags are ignored like --flicker-probe:
// the shipped app always shows the machines you add, never demo data.

export interface LaunchOptions {
  readonly demo: boolean;
  readonly captureDir: string | null;
  readonly captureQuit: boolean;
  /** The name prefixes of the captures to take (null: all of them). */
  readonly captureOnly: readonly string[] | null;
  readonly windowSize: { readonly width: number; readonly height: number } | null;
  readonly userDataDir: string | null;
  readonly lookProbeDir: string | null;
  readonly flickerProbeDir: string | null;
  readonly probeFile: string | null;
  readonly showcase: boolean;
  readonly showcaseCaptureDir: string | null;
}

function value(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const found = [...argv].reverse().find((arg) => arg.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

/** Where the app runs from: `packaged` is Electron's app.isPackaged (the shipped app). */
export interface LaunchContext {
  readonly packaged?: boolean;
}

/** The demo's and the development instruments' flags (the list above, less --window-size and --herdr-user-data). */
const instrumentFlags = ["demo", "capture", "capture-quit", "capture-only", "look-probe", "flicker-probe", "splits-probe", "showcase", "showcase-capture"] as const;

/**
 * Any of those flags on the command line, read raw. The
 * shipped app ignores them (parseLaunchOptions, below) and still shows the machines you add, but a run opened with one
 * never checks for updates (src/main/updates.ts, off reason "flags"): a demo or capture launch makes no request.
 * Nothing else turns on from this.
 */
export function hasInstrumentFlag(argv: readonly string[]): boolean {
  return argv.some((arg) => instrumentFlags.some((name) => arg === `--${name}` || arg.startsWith(`--${name}=`)));
}

export function parseLaunchOptions(argv: readonly string[], context: LaunchContext = {}): LaunchOptions {
  // The demo and the development instruments are off in the shipped app: their flags are ignored before they turn
  // on demo, a capture, a probe or the showcase.
  const shipped = context.packaged === true;
  const devValue = (name: string): string | null => (shipped ? null : value(argv, name));
  const captureDir = devValue("capture");
  const captureOnly = devValue("capture-only")?.split(",").map((part) => part.trim()).filter((part) => part.length > 0) ?? [];
  const lookProbeDir = devValue("look-probe");
  const flickerProbe = devValue("flicker-probe");
  const flickerProbeDir = flickerProbe !== null && flickerProbe.length > 0 ? flickerProbe : null;
  const probe = devValue("splits-probe");
  const probeFile = probe !== null && probe.length > 0 ? probe : null;
  const size = value(argv, "window-size")?.match(/^(\d{3,5})x(\d{3,5})$/);
  const showcaseCapture = devValue("showcase-capture");
  const showcaseCaptureDir = showcaseCapture !== null && showcaseCapture.length > 0 ? showcaseCapture : null;
  const showcase = (!shipped && argv.includes("--showcase")) || showcaseCaptureDir !== null;
  return {
    demo: (!shipped && argv.includes("--demo")) || captureDir !== null || lookProbeDir !== null || flickerProbeDir !== null || probeFile !== null || showcase,
    captureDir: captureDir && captureDir.length > 0 ? captureDir : null,
    captureQuit: argv.includes("--capture-quit"),
    captureOnly: captureOnly.length > 0 ? captureOnly : null,
    windowSize: size ? { width: Number(size[1]), height: Number(size[2]) } : null,
    userDataDir: value(argv, "herdr-user-data"),
    lookProbeDir: lookProbeDir && lookProbeDir.length > 0 ? lookProbeDir : null,
    flickerProbeDir,
    probeFile,
    showcase,
    showcaseCaptureDir,
  };
}
