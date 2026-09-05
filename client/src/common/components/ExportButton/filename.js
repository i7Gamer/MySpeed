/**
 * Names the file an export downloads as.
 *
 * All time has to reach the export endpoint as a concrete range, because that
 * endpoint takes one - so it travels as a window wide enough to contain
 * anything the server still keeps. Naming the file after that window produced
 * "myspeed-export-1999-03-26-to-2026-08-10.csv", which reads as a strangely
 * specific request rather than as "everything". Only the client can tell the
 * difference, since only it knows the range was a stand-in.
 *
 * A target narrows the export the same way: the rows are the one target's,
 * and a name that said nothing of it was the same name whether the file held
 * every target or one - two exports of the same week, indistinguishable in a
 * download folder.
 */
export const exportFilename = ({allTime = false, from, to, format, target = null}) => {
    const scope = target == null ? "" : `target-${target}-`;

    return allTime
        ? `myspeed-export-${scope}all-time.${format}`
        : `myspeed-export-${scope}${from}-to-${to}.${format}`;
};
