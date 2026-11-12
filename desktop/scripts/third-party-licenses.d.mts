// Types for scripts/third-party-licenses.mjs (test/settings-licenses.test.ts imports it).

export interface ThirdPartyComponent {
  readonly name: string;
  readonly version: string | null;
  readonly kind: "runtime" | "package" | "bundled" | "embedded" | "adapted" | "font";
  readonly license: string;
  readonly url: string | null;
  readonly source: string;
  readonly note?: string;
  readonly text: string;
}

export declare const defaultRoot: string;
export declare const licensesFile: string;
export declare function packageOfSpecifier(specifier: string): string | null;
export declare function importedPackages(root: string): string[];
export declare function thirdPartyLicenses(root?: string): { format: number; components: ThirdPartyComponent[] };
export declare function thirdPartyLicensesText(root?: string): string;
export declare function writeThirdPartyLicenses(root?: string): boolean;
