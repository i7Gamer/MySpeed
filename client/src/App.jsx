import React, {useState, useEffect} from 'react';
import {useTranslation} from 'react-i18next';
import {createBrowserRouter, Outlet, RouterProvider} from 'react-router-dom';
import '@fontsource/inter/300.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import "@/common/styles/default.sass";
import "@/common/styles/spinner.sass";
import HeaderComponent from "./common/components/Header";
import {SpeedtestProvider} from "./common/contexts/Speedtests";
import {ConfigProvider} from "./common/contexts/Config";
import {StatusProvider} from "./common/contexts/Status";
import {AlertProvider} from "@/common/contexts/Alert";
import {ThemeProvider} from "@/common/contexts/Theme";
import {PreferencesProvider} from "@/common/contexts/Preferences";
import i18n, {FALLBACK_LANGUAGE} from './i18n';
import {basePath} from "@/common/utils/BasePath";
import Loading from "@/pages/Loading";
import Error from "@/pages/Error";
import RouteError from "@/pages/RouteError";
import {ToastNotificationProvider} from "@/common/contexts/ToastNotification";
import {NodeProvider} from "@/common/contexts/Node";
import {library} from '@fortawesome/fontawesome-svg-core';
import {faBell, faBellConcierge, faDatabase, faGlobe, faHeartPulse} from '@fortawesome/free-solid-svg-icons';
import {faDiscord, faTelegram} from "@fortawesome/free-brands-svg-icons";
import {PushOverIcon} from "@/common/assets/icons/pushover";
import Nodes from "@/pages/Nodes";
import Statistics from "@/pages/Statistics";
import Home from "@/pages/Home";

library.add(faBell, faBellConcierge, faDatabase, faGlobe, faHeartPulse, faDiscord, faTelegram);
library.add(PushOverIcon);

const Providers = ({children}) => {
    // The one language subscription for the whole layout. Nearly every
    // component renders its strings with the global `t`, which reads the
    // current language but subscribes to nothing - so switching languages
    // only translated whatever re-rendered for its own reasons, and the
    // header kept its old words until a reload. This hook re-renders the
    // shell on languageChanged, and the render sweeps every global-t call
    // below it. (The memoised pagination subscribes for itself.)
    useTranslation();

    return (
        <ThemeProvider>
            <PreferencesProvider>
                <AlertProvider>
                    <ToastNotificationProvider>
                        <ConfigProvider>
                            <NodeProvider>
                                {/* Status wraps Speedtests: the tests list
                                    refreshes on the falling edge of the polled
                                    running flag, so it consumes the status
                                    context. */}
                                <StatusProvider>
                                    <SpeedtestProvider>
                                        {children}
                                    </SpeedtestProvider>
                                </StatusProvider>
                            </NodeProvider>
                        </ConfigProvider>
                    </ToastNotificationProvider>
                </AlertProvider>
            </PreferencesProvider>
        </ThemeProvider>
    );
};

/**
 * Built once, at module scope.
 *
 * RouterProvider treats a new router object as a different router: it remounts
 * the whole tree beneath it and drops the navigation state with it. Called from
 * inside App's body this produced a fresh one on every render. App only
 * re-renders twice today, when the translations resolve, so nothing visible
 * came of it - but it left the cost of any state ever added to App as a full
 * remount of the application, payable by whoever added it.
 */
const router = createBrowserRouter([
    {
        path: "/",
        element: (
            <Providers>
                <HeaderComponent/>
                <main><Outlet/></main>
            </Providers>
        ),
        errorElement: <RouteError />,
        children: [
            {path: "/", element: <Home/>},
            {path: "/nodes", element: <Nodes/>},
            {path: "/statistics", element: <Statistics/>}
        ]
    }
], {
    /*
     * Where the application starts, when it is not the root of the host -
     * upstream #771. Without it the router pushes "/statistics" into the address
     * bar of a page served from /internet_speed/, and the next reload asks the
     * proxy for a path outside the prefix.
     *
     * react-router wants "/" for "no prefix" rather than the empty string
     * BasePath answers with.
     */
    basename: basePath || "/"
});

const App = () => {
    /**
     * Seeded from what i18next has already done, rather than from false.
     *
     * `initialized` is emitted once and never replayed, and this component
     * cannot subscribe to it until index.jsx has awaited migrateStoredPassword()
     * - so on the upgrade path that migration exists for, the locale finishes
     * loading while the session request is still doing its bcrypt compare, the
     * event is emitted with nobody listening, and the app holds on the loading
     * screen with nothing left to wake it.
     */
    const [translationsLoaded, setTranslationsLoaded] = useState(i18n.isInitialized);
    const [translationError, setTranslationError] = useState(false);

    useEffect(() => {
        // Asked again here, not only at first render: the two are a paint apart,
        // and that is long enough for a promise callback to have run.
        if (i18n.isInitialized) {
            setTranslationsLoaded(true);
            return;
        }

        const loaded = () => setTranslationsLoaded(true);
        /*
         * A locale that would not load is only fatal when it leaves nothing to
         * render with.
         *
         * This used to fire for any language at all, and the fallback was
         * already configured - so upstream #1330, where the missing file was
         * da.json and English was perfectly fine, took the interface down for a
         * language nobody had asked to read it in. English is bundled now, so
         * the answer here is almost always "there is plenty left"; the check is
         * what makes that true rather than assumed.
         */
        const failed = () => {
            if (!i18n.hasResourceBundle(FALLBACK_LANGUAGE, "translation")) setTranslationError(true);
        };

        i18n.on("initialized", loaded);
        i18n.on("failedLoading", failed);

        return () => {
            i18n.off("initialized", loaded);
            i18n.off("failedLoading", failed);
        };
    }, []);

    if (!translationsLoaded && !translationError) {
        return <Loading/>;
    }

    if (translationError) {
        // disableReload, because this page reloads itself after five seconds by
        // default and the reload refetches the very thing that failed - which is
        // the loop both #725 and #1330 are named after. Nothing a reload can fix
        // is left by the time this renders: the bundled locale is gone, which
        // means i18next itself did not come up.
        return <Error text="Failed to load translations" disableReload/>;
    }

    return <RouterProvider router={router}/>;
};

export default App;
