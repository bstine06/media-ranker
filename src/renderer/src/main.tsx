import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { SettingsProvider } from "./contexts/SettingsContext";
import { StatusProvider } from "./contexts/StatusContext";
import { FolderProvider } from "./contexts/FolderContext";
import { TagsProvider } from "./contexts/TagsContext";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <FolderProvider>
            <TagsProvider>
                <SettingsProvider>
                    <StatusProvider>
                        <App />
                    </StatusProvider>
                </SettingsProvider>
            </TagsProvider>
        </FolderProvider>
    </React.StrictMode>,
);
