export function CrownIcon({ className }: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="currentColor"
            viewBox="0 0 20 20"
            className={className}
            aria-hidden="true"
        >
            <path d="M2.5 6.5 6.5 10 10 4l3.5 6 4-3.5-1.5 8.5h-12z" />
            <rect x="4" y="16" width="12" height="1.75" rx="0.5" />
        </svg>
    );
}
