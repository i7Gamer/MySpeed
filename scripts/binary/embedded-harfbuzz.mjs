import createHarfBuzz from "harfbuzzjs/hb.js";
import hbjs from "harfbuzzjs/hbjs.js";
import wasmPath from "harfbuzzjs/hb.wasm" with {type: "file"};

const harfbuzz = Bun.file(wasmPath).arrayBuffer()
    .then((wasmBinary) => createHarfBuzz({wasmBinary}))
    .then(hbjs);

export default harfbuzz;
