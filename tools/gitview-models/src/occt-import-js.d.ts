/**
 * Minimal ambient types for `occt-import-js`, which ships none.
 *
 * Needed because the CLI is now compiled rather than run through `tsx`: `tsx` does not typecheck, so an
 * untyped import was invisible until `tsc` was pointed at the same file. Kept deliberately thin — the
 * shapes the converter actually relies on (`ReadStepFile`, `ReadBrepFile` and their result) are already
 * declared next to their use in `convert.ts`, and duplicating them here would give two definitions to
 * keep in step. This only says "the default export is the Emscripten factory".
 */
declare module "occt-import-js" {
  const factory: (opts?: {
    print?: (s: string) => void;
    printErr?: (s: string) => void;
  }) => Promise<unknown>;
  export default factory;
}
