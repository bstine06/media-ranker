export function FolderIcon({
    className,
    onClick,
}: {
    className?: string;
    onClick?: () => void;
}) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="currentColor"
            viewBox="0 0 20 20"
            className={className}
            onClick={onClick}
        >
            <path d="M2 4a2 2 0 012-2h3l2 2h7a2 2 0 012 2v1H2V4z" />
            <path d="M2 7h16v7a2 2 0 01-2 2H4a2 2 0 01-2-2V7z" />
        </svg>
    );
}
