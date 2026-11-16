/** One file in focus with the next ones lined up after it (a pass). */
export function PassIcon({ className }: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinejoin="round"
            strokeLinecap="round"
            className={className}
        >
            <rect x="3" y="5" width="9" height="14" rx="1.2" />
            <path d="M15.5 8.5v7M19.5 10v4" />
        </svg>
    );
}
