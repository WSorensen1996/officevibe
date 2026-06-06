// Empty stub aliased over `onnxruntime-node` and `sharp` in the renderer build
// (see electron.vite.config.ts → renderer.resolve.alias). Transformers.js resolves
// to its WEB build here and never touches those native Node addons; this guarantees
// the bundler won't try to pull their prebuilt `.node` binaries into the renderer.
export default {};
