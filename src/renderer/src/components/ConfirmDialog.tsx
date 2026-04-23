import React from "react";

function ConfirmDialog({
    title,
    message,
    confirmText,
    onConfirm,
    onCancel,
}: {
    title: string,
    message: string,
    confirmText: string,
    onConfirm: () => void,
    onCancel?: () => void,
}): JSX.Element {
    return (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
            <div className="bg-neutral-900 rounded-lg p-6 w-96 shadow-xl"> 
                <h2 className="text-xl font-bold mb-4 text-neutral-200">{title}</h2>
                <p className="text-neutral-300 mb-6">{message}</p>
                
                <div className="flex gap-3 justify-end">
                    {onCancel && (
                        <button 
                            onClick={onCancel}
                            className="px-4 py-2 rounded bg-neutral-300 hover:bg-neutral-400 text-neutral-800"
                        >
                            Cancel
                        </button>
                    )}
                    <button 
                        onClick={onConfirm}
                        className="px-4 py-2 rounded bg-red-700 hover:bg-red-800 text-white"
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>
    )
}

export default ConfirmDialog;