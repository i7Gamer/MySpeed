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
import i18n from './i18n';
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

const App = () => {
    const [translationsLoaded, setTranslationsLoaded] = useState(false);
    const [translationError, setTranslationError] = useState(false);

    useEffect(() => {
        i18n.on("initialized", () => setTranslationsLoaded(true));
        i18n.on("failedLoading", () => setTranslationError(true));
    }, []);

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
    ]);

    if (!translationsLoaded && !translationError) {
        return <Loading/>;
    }

    if (translationError) {
        return <Error text="Failed to load translations"/>;
    }

    return <RouterProvider router={router}/>;
};

export default App;
