import {useContext} from "react";
import {t} from "i18next";
import "./styles.sass";
import SegmentedControl from "@/common/components/SegmentedControl";
import {TargetsContext} from "@/common/contexts/Targets";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {ALL_TARGETS, targetColour} from "@/common/utils/TargetUtil";

/**
 * The row that narrows both data pages to one target - drawn only once there
 * are two targets to tell apart, so a single-target instance looks exactly as
 * it always has.
 *
 * The selection is a viewer preference, not part of the shared URL: it
 * remembers how this reader slices the data across visits, the way their time
 * format does. Held as the target's id; selectedTargetId is what decides
 * whether that id still means anything.
 */
export const TargetChips = () => {
    const {targets, selectedTarget, selectionFor} = useContext(TargetsContext);
    const [, updatePreferences] = useContext(PreferencesContext);

    if (targets.length < 2) return null;

    const selected = selectedTarget ?? ALL_TARGETS;

    const options = [
        {id: ALL_TARGETS, label: t("targets.all")},
        ...targets.map((target, index) => ({
            id: target.id,
            label: target.name,
            adornment: <span className="target-dot" style={{background: targetColour(index)}}/>
        }))
    ];

    return (
        <div className="target-chips">
            <SegmentedControl options={options} value={selected} label={t("targets.title")}
                              onChange={(id) => updatePreferences(selectionFor(id))}/>
        </div>
    );
};

export default TargetChips;
