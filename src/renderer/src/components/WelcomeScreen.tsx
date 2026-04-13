import { useEffect, useState } from "react";

export default function WelcomeScreen({
    message,
    onSelect,
    isLoading,
}: {
    message: string | null;
    onSelect: () => void;
    isLoading: boolean;
}): JSX.Element {
    const [backendMessage, setBackendMessage] = useState<string | null>(null);
    const [backendProgress, setBackendProgress] = useState<
        [number, number] | null
    >(null);

    useEffect(() => {
        window.api.onProcessMessageSent(({ message, progress }) => {
            setBackendMessage(message);
            if (progress) setBackendProgress(progress);
        });
    }, []);

    return (
        <div className="flex h-full flex-col items-center justify-center gap-6 bg-neutral-950">
            <div className="titlebar-drag absolute inset-x-0 top-0 h-10" />
            <h1 className="text-3xl font-bold text-white">Media Ranker</h1>
            <p className="text-neutral-400">
                {message || "Choose a folder to begin."}
            </p>
            <p className="text-neutral-400 text-left">{backendMessage || ""}</p>
            {backendProgress && (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <div className="relative w-24 h-1 bg-neutral-700 rounded">
                            <div
                                className="absolute inset-y-0 left-0 bg-neutral-300 rounded"
                                style={{
                                    width: `${(backendProgress[0] / backendProgress[1]) * 100}%`,
                                }}
                            />
                        </div>
                    </div>
                    <div className="flex justify-between">
                        <p className="text-neutral-400 text-center">{`${backendProgress[0]}`}</p>
                        <p className="text-neutral-400 text-center">/</p>
                        <p className="text-neutral-400 text-center">{`${backendProgress[1]}`}</p>
                    </div>
                </div>
            )}
            <button
                onClick={onSelect}
                disabled={isLoading}
                className="rounded-lg bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:opacity-50"
            >
                {isLoading ? "Scanning…" : "Open Library Folder"}
            </button>
        </div>
    );
}
