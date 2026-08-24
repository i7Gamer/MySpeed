import {defineConfig, createLogger} from "vite";
import react from "@vitejs/plugin-react";
import {VitePWA} from "vite-plugin-pwa";
import * as path from "node:path";

const logger = createLogger();
const originalError = logger.error.bind(logger);
logger.error = (msg, options) => {
    if (msg.includes('http proxy error') && (msg.includes('AbortError') || msg.includes('cancelled') || msg.includes('AggregateError'))) return;
    originalError(msg, options);
};

export default defineConfig({
    /*
     * Relative, so index.html asks for its assets against wherever it was itself
     * served rather than against the root of the host - upstream #771, whose
     * report is exactly that: the page loads under a Traefik PathPrefix and then
     * asks for /assets/index.js, which is outside it.
     *
     * It is also what lets the client work out its own prefix at runtime, so one
     * build serves any subdirectory - see common/utils/BasePath.js.
     */
    base: "./",
    customLogger: logger,
    plugins: [
        // A new service worker otherwise waits for every tab to close before it
        // takes over, so an upgraded instance kept serving the previous build's
        // assets - users saw the old UI until they quit the browser.
        VitePWA({
            injectRegister: "auto",
            manifest: false,
            workbox: {skipWaiting: true, clientsClaim: true}
        }),
        react()
    ],
    build: {
        outDir: "build",
        chunkSizeWarningLimit: 1600,
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (id.includes('node_modules'))
                        return id.includes('@fortawesome') ? 'icons' : 'vendor';
                }
            }
        }
    },
    resolve: {
        alias: {
            // From import.meta rather than from the CommonJS directory global
            // this used to read, which is not defined in an ES module: it
            // resolved only because Vite bundles the config before running it,
            // and under the native loader the alias every client import depends
            // on would have resolved against nothing.
            //
            // The old global is named in viteConfigModule.test.js rather than
            // here, because the assertion that it is gone searches this file and
            // would otherwise find it in this sentence.
            "@": path.resolve(import.meta.dirname, "./src"),
        },
    },
    server: {
        proxy: {
            "/api": "http://localhost:5216/"
        }
    }
});