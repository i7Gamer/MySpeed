import {defineConfig, createLogger} from "vite";
import react from "@vitejs/plugin-react";
import {VitePWA} from "vite-plugin-pwa";
import * as path from "node:path";
import {fileURLToPath} from "node:url";

// Not the CommonJS directory global, which exists only while this file is
// loaded as CommonJS - true today solely because client/package.json declares
// no "type". This spelling says the same thing in both module systems.
const configDir = path.dirname(fileURLToPath(import.meta.url));

const logger = createLogger();
const originalError = logger.error.bind(logger);
logger.error = (msg, options) => {
    if (msg.includes('http proxy error') && (msg.includes('AbortError') || msg.includes('cancelled') || msg.includes('AggregateError'))) return;
    originalError(msg, options);
};

export default defineConfig({
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
            "@": path.resolve(configDir, "./src"),
        },
    },
    server: {
        proxy: {
            "/api": "http://localhost:5216/"
        }
    }
});