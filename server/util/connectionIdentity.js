/**
 * Who the connection is, as the provider saw it - the operator's own provider
 * and external address. Stored for the operator, withheld from read-only
 * viewers: an instance shared as a public dashboard must not tell every
 * visitor where its owner lives on the network.
 *
 * Nulled rather than deleted, and set even where the column never existed, so
 * a masked row is indistinguishable from one whose provider measured nothing -
 * the response must not reveal that something was withheld.
 */
export const stripConnectionIdentity = (row) => {
    if (!row) return row;

    row.isp = null;
    row.externalIp = null;

    return row;
};
