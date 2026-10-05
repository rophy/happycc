import { isRigMetadataV1, rigCanUseAttachments } from './rig';
import type { Metadata } from './storageTypes';

export type ImageAttachmentFlavor = string | null | undefined;

export type ImageAttachmentSendPlan = {
    supportsAttachments: boolean;
    shouldUseAttachments: boolean;
    shouldShowUnsupportedAlert: boolean;
    shouldSendText: boolean;
};

export function supportsImageAttachmentsForFlavor(flavor: ImageAttachmentFlavor): boolean {
    return !flavor || flavor === 'claude' || flavor === 'codex';
}

/**
 * Whether the composer offers image attachments for a session. Workstation-only builds transfer no
 * images between the app and the workstation (the CLI drops them and the server has no attachment
 * routes), so the picker, paste and drop are all off.
 */
export function sessionCanUseImageAttachments(
    metadata: Metadata | null | undefined,
    workstationOnly: boolean,
): boolean {
    if (workstationOnly) {
        return false;
    }
    return isRigMetadataV1(metadata)
        ? rigCanUseAttachments(metadata)
        : supportsImageAttachmentsForFlavor(metadata?.flavor);
}

export function getImageAttachmentSendPlan(opts: {
    flavor: ImageAttachmentFlavor;
    text: string;
    attachmentCount: number;
    supportsAttachments?: boolean;
}): ImageAttachmentSendPlan {
    const hasAttachments = opts.attachmentCount > 0;
    const supportsAttachments = opts.supportsAttachments ?? supportsImageAttachmentsForFlavor(opts.flavor);
    const shouldShowUnsupportedAlert = hasAttachments && !supportsAttachments;

    return {
        supportsAttachments,
        shouldUseAttachments: hasAttachments && supportsAttachments,
        shouldShowUnsupportedAlert,
        shouldSendText: !shouldShowUnsupportedAlert || opts.text.trim().length > 0,
    };
}

export function isAttachmentAllowedByPolicy(
    attachment: { mimeType: string; size: number },
    policy: { maxBytes: number; mediaTypes: string[] },
): boolean {
    const sizeAllowed = attachment.size <= 0 || attachment.size <= policy.maxBytes;
    const mediaAllowed = policy.mediaTypes.some((allowed) => (
        allowed === attachment.mimeType
        || (allowed.endsWith('/*') && attachment.mimeType.startsWith(allowed.slice(0, -1)))
    ));
    return sizeAllowed && mediaAllowed;
}
