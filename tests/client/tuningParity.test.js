import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    durationAccepted, streamsAccepted, TUNING_BOUNDS
} from "@/common/components/TargetsDialog/providerFields.js";
import { tuningOrNull } from "@/common/components/TargetsDialog/targetBody.js";
import { iperfTuningProblem } from "../../server/controller/targets.js";

/**
 * The client's question and the server's answer, held to be the same question
 * - the discipline iperfHostParity already keeps for the host field, applied
 * to the run's own shape.
 *
 * The two rules do not judge the same values, which is the trap this file is
 * shaped around. The editor judges what was typed: a string from a number
 * input, blank while the field is untouched. The door judges what arrived: a
 * JSON number or null, because targetBody parsed it on the way out. Feeding
 * one function the other's domain compares nothing - "5" is a valid duration
 * to type and not a valid one to send.
 *
 * So the property is the composition, over the path a value really takes:
 * type it, let targetBody build the body, ask the door. A value the editor
 * takes and the door then refuses is a save that fails naming a number the
 * operator is looking at, which is exactly what the host rule was copied to
 * avoid.
 */
const iperfTarget = (over) => ({provider: "iperf3", endpoint: "nas.lan", ...over});

const doorTakes = (field, typed) =>
    iperfTuningProblem(iperfTarget({[field]: tuningOrNull("iperf3", typed)})) === null;

// Every shape a number field can hold: the bounds and their neighbours, the
// blank that means "the default", and the spellings a spinner or a paste can
// produce.
const TYPED = ["", null, undefined, "5", "6", "60", "4", "61", "0", "-1", "1", "32", "33",
    " 10 ", "10.0", "1e1", "0x10", "010", "  "];

// What the body cannot carry: text that is not a number at all (Number() is
// NaN, and JSON has no NaN) and a fraction the column has no room for. Both
// reach the door as null and are taken there as "untouched", so the editor
// refusing them is the only thing standing between a typo and a target
// silently running the default. Asserted rather than swept into the table
// above, because here the two sides genuinely do differ.
const UNCARRIABLE = ["abc", "7.5", "7.5.1", "Infinity", "NaN", "--5"];

const FIELDS = [
    {name: "duration", accepted: durationAccepted, column: "iperfDuration", bounds: TUNING_BOUNDS.duration},
    {name: "stream count", accepted: streamsAccepted, column: "iperfStreams", bounds: TUNING_BOUNDS.streams}
];

describe("the editor and the door judge a run's shape the same way", () => {
    for (const field of FIELDS) {
        it(`agrees on every ${field.name} a body can carry`, () => {
            for (const typed of TYPED)
                assert.equal(field.accepted(typed), doorTakes(field.column, typed),
                    `the two sides disagree about a ${field.name} of ${JSON.stringify(typed)}`);
        });

        /**
         * And the bounds the inputs state to the operator are the bounds the
         * rule enforces: a spinner that steps to 61 offers a refusal, and one
         * that stops at 30 hides half of what the door takes.
         */
        it(`states the ${field.name} bounds it enforces`, () => {
            const {min, max} = field.bounds;

            for (const inside of [min, max])
                assert.equal(field.accepted(String(inside)), true, `${inside} was refused`);

            for (const outside of [min - 1, max + 1])
                assert.equal(field.accepted(String(outside)), false, `${outside} was taken`);
        });

        // The blank field is the whole point of the nullable column: it is not
        // a bad value, it is the operator leaving the registry's default alone.
        it(`takes an untouched ${field.name} on both sides`, () => {
            for (const blank of ["", null, undefined]) {
                assert.equal(field.accepted(blank), true, `${JSON.stringify(blank)} was refused`);
                assert.equal(doorTakes(field.column, blank), true, `${JSON.stringify(blank)} was refused by the door`);
            }
        });

        // The one asymmetry, stated rather than hidden: the door cannot see
        // this text, so the greyed button is the whole defence. If the editor
        // ever stops refusing it, a typo is stored as "no opinion" in silence.
        it(`refuses a ${field.name} no body can carry`, () => {
            for (const typed of UNCARRIABLE) {
                assert.equal(field.accepted(typed), false, `the editor took ${JSON.stringify(typed)}`);
                assert.equal(tuningOrNull("iperf3", typed), null,
                    `${JSON.stringify(typed)} reached the body as something other than null`);
            }
        });
    }

    // The door's other half: tuning on a provider that decides its own run.
    // targetBody nulls it on the way out, so the editor can never produce this
    // - but the API is open and the rule is the reason the column is nullable.
    it("refuses tuning on a provider that takes none", () => {
        for (const provider of ["ookla", "libre", "cloudflare"]) {
            assert.equal(tuningOrNull(provider, "10"), null,
                `${provider} carried a duration out of the editor`);
            assert.notEqual(iperfTuningProblem({provider, iperfDuration: 10}), null,
                `the door took a duration on ${provider}`);
        }
    });
});
