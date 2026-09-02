import { useState } from "react";
import "./counter.sass";

/**
 * The smallest component that exercises what the loader has to do: JSX with
 * the automatic runtime, a hook, an event, and a stylesheet import that a
 * bundler would take and node must be taught to ignore.
 */
export const Counter = () => {
    const [count, setCount] = useState(0);

    return <button type="button" onClick={() => setCount(count + 1)}>{count}</button>;
};
