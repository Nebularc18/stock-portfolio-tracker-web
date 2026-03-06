import { RefObject, useEffect, useRef } from 'react'

interface UseModalFocusTrapOptions {
  modalRef: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  initialFocusRef?: RefObject<HTMLElement | null>
}

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled'),
  )
}

export function useModalFocusTrap({ modalRef, open, onClose, initialFocusRef }: UseModalFocusTrapOptions) {
  const previousFocusedElementRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return

    const modalElement = modalRef.current
    if (!modalElement) return

    previousFocusedElementRef.current = document.activeElement as HTMLElement | null

    if (initialFocusRef?.current) {
      initialFocusRef.current.focus()
    } else {
      const focusableElements = getFocusableElements(modalElement)
      if (focusableElements.length > 0) {
        focusableElements[0].focus()
      } else {
        modalElement.focus()
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }

      if (event.key !== 'Tab') return

      const currentFocusable = getFocusableElements(modalElement)
      if (currentFocusable.length === 0) {
        event.preventDefault()
        modalElement.focus()
        return
      }

      const first = currentFocusable[0]
      const last = currentFocusable[currentFocusable.length - 1]
      const activeElement = document.activeElement as HTMLElement | null

      if (event.shiftKey && activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousFocusedElementRef.current?.focus()
    }
  }, [initialFocusRef, modalRef, onClose, open])
}
