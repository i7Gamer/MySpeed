import {t} from "i18next";
import FigureWithUnit from "@/common/components/FigureWithUnit";

/**
 * The hop table a degraded run left behind: every hop between this machine
 * and the test server, the address that answered, every latency it answered
 * with, and how many probes never came back.
 *
 * Not read for the reader. A hop that never answers is as often an operator
 * that drops probes as a fault, so the table marks the hops with losses and
 * leaves the reading to a person - who can tell a dead first hop (the
 * router) from stars somewhere past the provider's gateway.
 *
 * Nothing at all for a run with no table, which is every run that went
 * well: the section has no empty state to show.
 */
/**
 * Whether a hop has what a row needs. The server refuses a malformed table
 * on the way in and on the way out, but the pane also draws what a proxied
 * node sends, and one hop it cannot draw must not cost the rest of the pane.
 */
// The number as well as the latencies: the rows are keyed on it, and two
// hops without one collide on the same key.
const drawable = (hop) => hop !== null && typeof hop === "object" && Number.isInteger(hop.hop) && Array.isArray(hop.rtt)
    && (hop.address === null || typeof hop.address === "string");

const RouteTable = ({hops}) => {
    const rows = Array.isArray(hops) ? hops.filter(drawable) : [];
    if (rows.length === 0) return null;

    return (
        <div className="detail-route">
            <h3>{t("test.details.route")}</h3>
            <div className="detail-route-scroll">
                <table>
                    <thead>
                        <tr>
                            <th>{t("test.details.route_hop")}</th>
                            <th>{t("test.details.route_address")}</th>
                            <th>{t("test.details.route_latency")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((hop) => (
                            <tr key={hop.hop}
                                className={hop.lost > 0 || hop.address == null ? "detail-hop-lost" : undefined}>
                                <td>{hop.hop}</td>
                                <td>{hop.address ?? t("test.details.route_no_reply")}</td>
                                <td>
                                    {hop.rtt.map((rtt, index) => (
                                        <span key={index} className="detail-route-rtt">
                                            <FigureWithUnit value={rtt} unit="ms" unitClass="detail-route-unit"/>
                                        </span>
                                    ))}
                                    {/* Only beside an answer: a hop with no
                                        answer at all already says "no reply". */}
                                    {hop.lost > 0 && hop.rtt.length > 0 && (
                                        <span className="detail-route-lost">
                                            {t("test.details.route_lost", {count: hop.lost})}
                                        </span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default RouteTable;
