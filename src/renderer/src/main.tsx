import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { SettingsProvider } from "./contexts/SettingsContext";
import { StatusProvider } from "./contexts/StatusContext";
import { FolderProvider } from "./contexts/FolderContext";
import { TagsProvider } from "./contexts/TagsContext";
import { DragProvider } from "./contexts/DragContext";
import { KingOfHillProvider } from "./contexts/KingOfHillContext";
import { PlacementProvider } from "./contexts/PlacementContext";
import { RankProvider } from "./contexts/RankContext";
import { TagPointerProvider } from "./contexts/TagPointerContext";
import { PassProvider } from "./contexts/PassContext";
import { PendingChangeProvider } from "./contexts/PendingChangeContext";
import { MediaLayerProvider } from "./media/MediaLayer";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <FolderProvider>
            <TagsProvider>
                <SettingsProvider>
                    <StatusProvider>
                        <DragProvider>
                                <KingOfHillProvider>
                                    <PlacementProvider>
                                        <RankProvider>
                                            <TagPointerProvider>
                                                <PassProvider>
                                                    <PendingChangeProvider>
                                                        <MediaLayerProvider>
                                                            <App />
                                                        </MediaLayerProvider>
                                                    </PendingChangeProvider>
                                                </PassProvider>
                                            </TagPointerProvider>
                                        </RankProvider>
                                    </PlacementProvider>
                                </KingOfHillProvider>
                        </DragProvider>
                    </StatusProvider>
                </SettingsProvider>
            </TagsProvider>
        </FolderProvider>
    </React.StrictMode>,
);
