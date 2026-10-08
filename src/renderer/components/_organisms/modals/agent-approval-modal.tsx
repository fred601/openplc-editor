import { useOpenPLCStore } from '@root/renderer/store'

import { Modal, ModalContent, ModalTitle } from '../../_molecules/modal'

const AgentApprovalModal = () => {
  const { modals, modalActions } = useOpenPLCStore()
  const isOpen = modals['agent-approval']?.open || false
  const modalData = modals['agent-approval']?.data as {
    requestId: string
    action: string
    message: string
  } | null

  const answer = (approved: boolean) => {
    if (modalData?.requestId) window.bridge.agentApprovalResponse(modalData.requestId, approved)
    modalActions.closeModal()
  }

  if (!modalData) return null

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && answer(false)}>
      <ModalContent className='flex min-h-[180px] w-[460px] select-none flex-col items-center justify-start rounded-lg p-6'>
        <ModalTitle className='mb-4 text-xl font-semibold'>Agent is waiting</ModalTitle>
        <p className='mb-2 text-center text-sm text-neutral-700 dark:text-neutral-300'>{modalData.message}</p>
        <p className='mb-6 text-center text-xs text-neutral-500'>{modalData.action}</p>
        <div className='mt-4 flex w-full gap-3'>
          <button
            type='button'
            onClick={() => answer(true)}
            className='flex-1 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-medium-dark'
          >
            Allow
          </button>
          <button
            type='button'
            onClick={() => answer(false)}
            className='flex-1 rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-1000 hover:bg-neutral-200 dark:bg-neutral-850 dark:text-neutral-100'
          >
            Deny
          </button>
        </div>
      </ModalContent>
    </Modal>
  )
}

export { AgentApprovalModal }
