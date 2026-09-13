import assert from "node:assert/strict";
import db from "../../server/config/database.js";
import {runMigrations} from "../../server/util/migrationRunner.js";
import Speedtests from "../../server/models/Speedtests.js";
import generateOpenGraphImage from "../../server/controller/opengraph.js";
import {readEmbeddedFile} from "../../server/clientEmbed.js";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const WIDTH = 1200;
const HEIGHT = 600;
const IHDR_WIDTH_OFFSET = 16;
const IHDR_HEIGHT_OFFSET = 20;

const localFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
    if (String(input).startsWith("data:")) return localFetch(input);
    throw new Error(`Network access is forbidden in the compiled renderer probe: ${input}`);
};

try {
    await db.authenticate();
    await runMigrations();
    await Speedtests.create({
        ping: 12,
        jitter: 2,
        download: 123,
        upload: 45,
        time: 30,
        serverId: 0,
        type: "auto",
        error: null,
        provider: "ookla",
        created: new Date().toISOString(),
    });

    const png = Buffer.from(await generateOpenGraphImage());
    assert.ok(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE));
    assert.equal(png.readUInt32BE(IHDR_WIDTH_OFFSET), WIDTH);
    assert.equal(png.readUInt32BE(IHDR_HEIGHT_OFFSET), HEIGHT);
    const notices = (await readEmbeddedFile("/third-party-notices.txt")).toString("utf8");
    assert.match(notices, /harfbuzzjs 0\.10\.0/);
    assert.match(notices, /Apache License 2\.0/);
    assert.match(notices, /@xhmikosr\/decompress 11\.1\.4/);
    assert.match(notices, /@xhmikosr\/decompress-targz 9\.0\.1/);
    assert.match(notices, /@xhmikosr\/decompress-unzip 8\.2\.1/);
    assert.match(notices, /@xhmikosr\/decompress-tar 9\.0\.2/);
    assert.match(notices, /@xhmikosr\/decompress-tarbz2 9\.0\.2/);
    assert.match(notices, /Copyright \(c\) Kevin Mårtensson/);
    assert.match(notices, /graceful-fs 4\.2\.11/);
    assert.match(notices, /Isaac Z\. Schlueter, Ben Noordhuis/);
    assert.match(notices, /file-type 21\.3\.4/);
    assert.match(notices, /Sindre Sorhus/);
    assert.match(notices, /yauzl 3\.4\.0/);
    assert.match(notices, /Josh Wolfe/);
    assert.match(notices, /tar-stream 3\.1\.7/);
    assert.match(notices, /Mathias Buus/);
    console.log(`opengraph=ok bytes=${png.length}`);
} finally {
    await db.close().catch(() => undefined);
}
