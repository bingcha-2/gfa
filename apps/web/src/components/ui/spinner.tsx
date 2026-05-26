import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

function Spinner({
  className,
  size,
  color,
  style,
  ...props
}: React.ComponentProps<"svg"> & { size?: number | string; color?: string }) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      style={{ width: size, height: size, color, ...style }}
      {...props}
    />
  )
}

export { Spinner }
