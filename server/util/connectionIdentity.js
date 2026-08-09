/**
 * Who the connection is, as the provider saw it - the operator's own provider
 * and external address. Stored for the operator, withheld from read-only
 * viewers: an instance shared as a public dashboard must not tell every
 * visitor where its owner lives on the network.
 *
 * Nulled rather than deleted, and set even where the column never existed, so
 * a masked row is indistinguishable from one whose provider measured nothing -
 * the response must not reveal that something was withheld.
 *
 * The result id goes with them: it is identity through a side door, linking to
 * the provider's public result page, which names the ISP and the rough
 * location. Deleted rather than nulled, unlike the other two, because absence
 * is what a row without a result already looks like - every list path strips a
 * null resultId key - so deletion says nothing where a null would say "there is
 * a result you cannot see".
 */
export const stripConnectionIdentity = (row) => {
    if (!row) return row;

    row.isp = null;
    row.externalIp = null;
    delete row.resultId;

    return row;
};
