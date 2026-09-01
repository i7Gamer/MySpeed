import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    bitrateAccepted, durationAccepted, streamsAccepted, tuningAccepted, IPERF_DEFAULTS, TUNING_BOUNDS
} from "@/common/components/TargetsDialog/providerFields.js";
import { targetBody, tuningOrNull } from "@/common/components/TargetsDialog/targetBody.js";
import { iperfTuningProblem } from "../../server/controller/targets.js";
import { IPERF_DURATION_SECONDS, IPERF_STREAMS } from "../../server/util/providers/registry.js";
import { readSource } from "../helpers/source.js";

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

/**
 * The same discipline over the datagram mode, where the two sides have more to
 * disagree about: the rate is required rather than optional, and the stream
 * count the editor may be holding is one the door refuses outright.
 *
 * Asserted through the whole body rather than field by field, because that is
 * where those interactions live - targetBody is what turns "the toggle is on"
 * into a row, and a rule the editor keeps that the body then undoes would pass
 * every per-field check and still fail the save.
 */
describe("the editor and the door judge a UDP run the same way", () => {
    const editorState = (over) => ({name: "LAN", provider: "iperf3", endpoint: "nas.lan",
        serverId: "none", alerts: true, ownOptimals: false,
        optimalPing: "", optimalDownload: "", optimalUpload: "",
        iperfDuration: "", iperfStreams: "", iperfUdp: false, iperfBitrate: "", ...over});

    // What the editor would let the operator press Save on, for the tuning
    // fields alone - the same term canSave carries, in one place a test can
    // ask without rendering the dialog.
    const buttonLives = (state) => tuningAccepted(state);

    const doorTakesBody = (state) => iperfTuningProblem(targetBody(state)) === null;

    const STATES = [
        {iperfUdp: false},
        {iperfUdp: true, iperfBitrate: "100"},
        {iperfUdp: true, iperfBitrate: "1"},
        {iperfUdp: true, iperfBitrate: "10000"},
        {iperfUdp: true, iperfBitrate: "10001"},
        {iperfUdp: true, iperfBitrate: "0"},
        {iperfUdp: true, iperfBitrate: ""},
        {iperfUdp: true, iperfBitrate: null},
        {iperfUdp: true, iperfBitrate: "100", iperfDuration: "30"},
        {iperfUdp: true, iperfBitrate: "100", iperfStreams: "8"},
        {iperfUdp: true, iperfBitrate: "100", iperfStreams: "1"},
        {iperfUdp: false, iperfBitrate: "100"},
        {iperfUdp: false, iperfStreams: "8"},
        // A stream count the door would refuse, on a run that has no stream
        // count to show: the editor replaces that field with the bitrate the
        // moment UDP goes on, so a value left in it can be neither seen nor
        // corrected.
        {iperfUdp: true, iperfBitrate: "100", iperfStreams: "50"},
        {iperfUdp: true, iperfBitrate: "100", iperfStreams: "0"},
        // And a duration the door would refuse is still on screen, so it
        // still counts.
        {iperfUdp: true, iperfBitrate: "100", iperfDuration: "3"}
    ];

    it("agrees on every state the toggle and its rate can be in", () => {
        for (const over of STATES) {
            const state = editorState(over);

            assert.equal(buttonLives(state), doorTakesBody(state),
                `the two sides disagree about ${JSON.stringify(over)}`);
        }
    });

    /**
     * And the pair that cannot work is resolved rather than merely refused.
     *
     * The door refuses UDP over more than one stream, so an editor that only
     * greyed its button would strand a target that had eight streams and then
     * turned the toggle on - with the offending field not even drawn, because
     * a UDP run has no stream count to show. The body drops it instead, which
     * is why the state above is saveable at all.
     */
    it("resolves a stream count a UDP run cannot use rather than stranding it", () => {
        const state = editorState({iperfUdp: true, iperfBitrate: "100", iperfStreams: "8"});

        assert.equal(buttonLives(state), true, "the button died on a field the dialog does not draw");
        assert.equal(targetBody(state).iperfStreams, null, "the stream count travelled with the save");
        assert.equal(iperfTuningProblem(targetBody(state)), null);
    });

    // The rate is the one field here with no valid blank, and both sides say so.
    it("requires a rate on both sides once datagrams are asked for", () => {
        for (const blank of ["", null, undefined]) {
            assert.equal(bitrateAccepted(blank, true), false,
                `the editor took a UDP run with a bitrate of ${JSON.stringify(blank)}`);
            assert.notEqual(iperfTuningProblem(targetBody(editorState({iperfUdp: true, iperfBitrate: blank}))),
                null, `the door took a UDP run with a bitrate of ${JSON.stringify(blank)}`);
        }
    });

    // And off, it is not a field: no value in it may keep the button down.
    it("ignores whatever a TCP target left in the rate", () => {
        for (const left of ["", "100", "0", "abc", "99999999"])
            assert.equal(bitrateAccepted(left, false), true,
                `a TCP target was held to a bitrate of ${JSON.stringify(left)}`);
    });

    /**
     * What a blank field actually gets, said where the operator is looking.
     *
     * The placeholders printed the *minimum* the bounds allow - 5 seconds, 1
     * stream - while a blank field runs the registry's defaults of 10 and 4:
     * buildArgs falls back with `??`, so the dialog promised half the duration
     * and a quarter of the streams the run then used. A placeholder is the one
     * sentence the field speaks while empty, and it was wrong on both fields.
     *
     * The client cannot import the registry - the bundle must not carry the
     * server - so it keeps a copy, and this is the test that holds the copy to
     * the original, the way the bounds themselves are held above.
     */
    it("suggests the default a blank field really runs", () => {
        assert.equal(IPERF_DEFAULTS.duration, IPERF_DURATION_SECONDS);
        assert.equal(IPERF_DEFAULTS.streams, IPERF_STREAMS);
    });

    // And they have to be legal to type, or the suggestion is a value the
    // button would grey on the moment somebody takes it literally.
    it("suggests defaults the editor itself accepts", () => {
        assert.equal(durationAccepted(String(IPERF_DEFAULTS.duration)), true);
        assert.equal(streamsAccepted(String(IPERF_DEFAULTS.streams)), true);
    });

    /**
     * The wiring itself, read as text the way the suite reads all JSX - and
     * scoped to each field's own block, the way customServerId.test.js scopes
     * its scan: matched against the whole file, the two assertions could not
     * tell the duration input from the streams input, and swapping the two
     * placeholders left every one of them green. Each label opens with its
     * translation key, so the stretch from the key to the input's onChange is
     * the field.
     *
     * Bitrate is deliberately absent: a UDP run must name a rate - there is
     * no default to advertise - so its placeholder stays the example it
     * always was.
     */
    it("prints each default on the field it belongs to", () => {
        const editor = readSource("client/src/common/components/TargetsDialog/TargetEditor.jsx");
        const fieldBlock = (key) => {
            // Generous enough for the field's own attributes and comments,
            // tight enough that it cannot reach the next field's input.
            const match = editor.match(new RegExp(`dialog\\.provider\\.${key}[\\s\\S]{0,900}?onChange`));
            assert.ok(match, `no ${key} field found in the editor`);
            return match[0];
        };

        assert.match(fieldBlock("iperf_duration"), /placeholder=\{String\(IPERF_DEFAULTS\.duration\)\}/,
            "the duration field does not offer the default a blank field runs");
        assert.match(fieldBlock("iperf_streams"), /placeholder=\{String\(IPERF_DEFAULTS\.streams\)\}/,
            "the streams field does not offer the default a blank field runs");
        assert.doesNotMatch(editor, /placeholder=\{String\(TUNING_BOUNDS\.(duration|streams)\.min\)\}/,
            "a placeholder still advertises the minimum as if it were the default");
    });

    /**
     * And a provider that draws none of these fields is held to none of them.
     *
     * Switching the provider unmounts the whole run-settings block and
     * deliberately does not clear what was typed in it - switching back has to
     * return the operator to their own values. So every one of these states is
     * reachable by picking iperf3, touching a field, and changing your mind:
     * left in the button's terms they greyed Add on an ookla target with no
     * field on screen to fix and no control that could reach one.
     */
    it("holds a provider that draws none of these fields to none of them", () => {
        const stranded = [
            {iperfUdp: true, iperfBitrate: ""},
            {iperfBitrate: "100"},
            {iperfDuration: "3"},
            {iperfStreams: "50"},
            {iperfDuration: "abc", iperfStreams: "0", iperfUdp: true, iperfBitrate: "99999"}
        ];

        for (const provider of ["ookla", "libre", "cloudflare"])
            for (const over of stranded) {
                const state = editorState({provider, endpoint: "", ...over});

                assert.equal(tuningAccepted(state), true,
                    `${provider} kept the button down on ${JSON.stringify(over)}`);
                assert.equal(iperfTuningProblem(targetBody(state)), null,
                    `${provider} carried ${JSON.stringify(over)} into a refusal`);
            }
    });
});
