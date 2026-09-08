import {after, before, it} from "node:test";
import assert from "node:assert/strict";
import {bootServer, api, seedTarget} from "./helpers/boot.js";

let server;
before(async () => { server = await bootServer(); });
after(async () => { await server?.close(); });

it("does not log a connection change from imported expanded IPv6 to the same live address", async () => {
    const target = await seedTarget({name: "WAN"});
    const previousIp = "2001:0db8:0000:0000:0000:0000:0000:0001";
    const currentIp = "2001:db8::1";
    const MINUTE_MS = 60_000;
    const previousCreated = new Date(Date.now() - MINUTE_MS).toISOString();
    const currentCreated = new Date().toISOString();
    const previous = {
        type: "auto", created: previousCreated, ping: 10, download: 100, upload: 50,
        provider: "ookla", isp: "Net", externalIp: previousIp, targetName: target.name
    };
    const imported = await api(server.baseUrl, "/storage/tests/history", {
        method: "PUT", headers: {"content-type": "application/json"}, body: JSON.stringify([previous])
    });
    assert.equal(imported.status, 200);
    const importedRow = await server.tests.findOne({where: {created: previousCreated}});
    assert.equal(importedRow.externalIp, previousIp);
    assert.equal(importedRow.targetId, target.id);

    const live = await server.tests.create({...previous, targetId: target.id, created: currentCreated, externalIp: currentIp});
    const changes = await import("../../server/controller/connectionChanges.js");
    assert.equal(await changes.recordChange(live.toJSON(), target), null);
    assert.deepEqual(await changes.listChanges(), []);
    assert.equal((await server.tests.findByPk(live.id)).externalIp, currentIp);
    assert.equal((await server.tests.findByPk(importedRow.id)).externalIp, previousIp);
});
