export default function NavItem({
  label,
  active = false,
  onClick,
}: {
  label: string
  active?: boolean
  onClick?: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-md px-0 py-2 text-center text-xs transition-colors ${
        active
          ? 'bg-neutral-700 text-white'
          : 'text-neutral-400 hover:bg-neutral-800 hover:text-white'
      }`}
    >
      {label}
    </button>
  )
}