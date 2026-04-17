export default function NavItem({
  icon,
  active = false,
  onClick,
  title
}: {
  icon: React.ReactNode
  active?: boolean
  onClick?: () => void
  title?: string
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-full flex rounded-md px-0 py-2 items-center justify-center text-xs transition-colors ${
        active
          ? 'bg-neutral-700 text-white'
          : 'text-neutral-400 hover:bg-neutral-800 hover:text-white'
      }`}
    >
      {icon}
    </button>
  )
}