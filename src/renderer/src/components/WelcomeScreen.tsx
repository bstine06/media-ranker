export default function WelcomeScreen({
    message,
    onSelect,
    isLoading,
}: {
    message: string | null;
    onSelect: () => void;
    isLoading: boolean;
}): JSX.Element {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-6 bg-neutral-950">
            <div className="titlebar-drag absolute inset-x-0 top-0 h-10" />
            <h1 className="text-3xl font-bold text-white">Media Ranker</h1>
            <p className="text-neutral-400">{message || "Choose a folder to begin."}</p>
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