/** Counter-clockwise arrow: rotate left a quarter turn. */
export function RotateIcon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
        >
            <path d="M4.5 8.5A6 6 0 1 1 6 14.5" />
            <path d="M4 4v4.5h4.5" />
        </svg>
    );
}
