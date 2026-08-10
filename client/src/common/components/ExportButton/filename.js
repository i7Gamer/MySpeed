/**
 * Names the file an export downloads as.
 *
 * All time has to reach the export endpoint as a concrete range, because that
 * endpoint takes one - so it travels as a window wide enough to contain
 * anything the server still keeps. Naming the file after that window produced
 * "myspeed-export-1999-03-26-to-2026-08-10.csv", which reads as a strangely
 * specific request rather than as "everything". Only the client can tell the
 * difference, since only it knows the range was a stand-in.
 */
export const exportFilename = ({allTime = false, from, to, format}) =>
    allTime
        ? `myspeed-export-all-time.${format}`
        : `myspeed-export-${from}-to-${to}.${format}`;
