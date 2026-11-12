// esbuild loaders (scripts/build.mjs): recorded terminal streams as bytes, text as strings.
declare module "*.hfx" {
  const bytes: Uint8Array;
  export default bytes;
}
declare module "*.txt" {
  const text: string;
  export default text;
}
