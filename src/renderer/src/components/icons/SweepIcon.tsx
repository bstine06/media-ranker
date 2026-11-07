/** Three lanes side by side (Sweep). */
export function SweepIcon({ className }: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinejoin="round"
            className={className}
        >
            <rect x="3" y="4.5" width="5" height="15" rx="1.2" />
            <rect x="9.5" y="4.5" width="5" height="15" rx="1.2" />
            <rect x="16" y="4.5" width="5" height="15" rx="1.2" />
        </svg>
    );
}
