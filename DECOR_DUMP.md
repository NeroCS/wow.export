# DecorDump customization

Fork of wow.export 0.2.19 at upstream c2fd7bde36a712be78a5da896c995b84fbfa2545.

## Build and run (Windows x64)

1. Install dependencies: `npm install`.
2. Run `npm run build:decordump`. The first build downloads the official portable
   runtime (~335 MB), reuses its matching native dependencies, and bundles this source.
3. Double-click `Start-DecorDump.cmd` or open `bin/decordump/wow.export.exe`.

This build uses separate settings/cache and disables upstream auto-updates so an
update cannot replace the customization. Close the app before rebuilding.
The original build.js remains available for full upstream builds.

## Use

1. In WoW run /decordump, wait for the result, then /reload.
2. Select your local installation (folder containing .build.info and Data), then Retail.
3. Choose an export directory in Settings.
4. Open **Decor → My DecorDump → Import DecorDump.lua** and select the saved file
   at WTF/Account/<account>/SavedVariables/DecorDump.lua.
5. Enable **Textures** and **Texture Alpha**. Try **Export first 10 GLBs**, then
   **Export all available GLBs**.

The importer accepts the current eleven-column SavedVariables format, including
escaped strings, comments and array indices. Identical repeated catalog rows are collapsed without summing quantities; conflicting repeats are rejected. It never executes Lua. Malformed files
and unsupported future schemas are rejected, preserving the previous import.

Each unique nonempty model ID with have > 0 is exported once through the existing
M2/M3/WMO exporter. The batch ignores current category filters, selection, preview
pose, and geoset masks. Unnamed files can still be fetched by ID.

## Material blending

glTF materials carry the M2 blend mode and flags rather than exporting as flat opaque:
`blendingMode` 1 becomes `alphaMode: MASK`, 2 becomes `BLEND`, and the two-sided and unlit flags
become `doubleSided` and `KHR_materials_unlit`. glTF has no additive or modulate mode, so 3/4/7
and 5/6 export as `BLEND` plus `extras.blendMode` (`add`, `mod`, `mod2x`) with the raw
`m2BlendingMode`/`m2MaterialFlags` beside it; a renderer that ignores extras still gets ordinary
transparency instead of a solid black quad. The mapping lives in
`src/js/3D/writers/gltf-material-blend.js` and is covered by `npm run test:decordump`.

Exports made before this was added render alpha cut-outs as filled quads and glow billboards as
black squares. The export profile is `decordump-glb-v2` because of it: resume reuses any GLB whose
checksum still matches, so without a new profile a re-export would silently keep the opaque files.
A re-export therefore lands in a new `decordump/<hash>/` folder, leaving the old one intact — point
the planner at the new `catalog.json`.

## Output and resume

    decordump/<build-and-export-profile-hash>/
      catalog.json
      models/<FileDataID>.glb

catalog.json contains all imported rows, quantity semantics, unresolved record IDs,
client/build provenance, export settings, statuses/warnings, relative model paths,
byte counts, and SHA-256 checksums.

Ready/partial files are checked and reused. Failed, missing or changed files are
retried. First-10 selects the first ten unique numeric IDs; it is not a representative
visual sample. Other models remain pending. Cancel saves progress without publishing
an unfinished model. Builds/export profiles use separate folders.

GLB header/length, JSON, geometry presence and external resources are checked before
publication. This is an integrity check, not full glTF conformance or visual certification.

## Current limits

- have is stored plus redeemable copies; already-placed copies and total ownership
  are unknown. No addon changes are required to import the current dump.
- Missing model IDs remain unresolved; they are not guessed.
- Default appearance only. Dyes, effects, physical dimensions and pivots need comparison
  with WoW. Upstream texture errors may require reading its runtime log.
- Upstream WMO GLB export omits embedded doodads; those exports are marked partial.
  Models without base-color textures are also marked partial for inspection.
- The source may download metadata/assets through upstream's normal network behavior.
  The addon dump has no build number, so an exact snapshot/client match cannot be verified.
- Exports run serially inside the app. A headless CLI, MCP server and room planner
  are later work.

## Checks

Run `npm run test:decordump` (no game files required).
Inspect a real dump without exporting:

    node scripts/inspect-decordump.js "<path to SavedVariables/DecorDump.lua>"

Keep personal dumps and extracted models outside the source repository.


Local verification (2026-09-13): the packaged app imported the real dump (2,066 unique catalog entries, 953 available entries, 915 model IDs) and exported the first ten models with 10 successes and no export warnings/failures. This does not establish full-catalog coverage or in-game visual fidelity.
