# iMessage BlueBubbles Replacement Checklist

This tracks the remaining work before the bundled `imessage` plugin can be called a full BlueBubbles replacement.

## Live macOS validation

- [ ] Validate `imsg launch` setup and private API detection through `openclaw channels status`.
- [ ] Send a normal text message through OpenClaw.
- [ ] Send an attachment through `upload-file`.
- [ ] Send with expressive effects through `sendWithEffect`.
- [ ] Reply to a message using short `MessageSid`.
- [ ] Reply to a message using `MessageSidFull`.
- [ ] Add and remove tapbacks through `react`.
- [ ] Edit a sent message on supported macOS versions.
- [ ] Unsend a sent message on supported macOS versions.
- [ ] Rename a group through `renameGroup`.
- [ ] Set a group icon through `setGroupIcon`.
- [ ] Add and remove group participants.
- [ ] Leave a group.

## Parity audit

- [ ] Compare remaining BlueBubbles action surfaces for typing/read receipts.
- [ ] Compare chat lifecycle actions: create chat, delete chat, mark read.
- [ ] Compare search/account/contact introspection surfaces.
- [ ] Compare inbound reaction/update event behavior.
- [ ] Confirm attachment receive/send behavior covers expected BB workflows.

## OpenClaw integration

- [ ] Update iMessage channel docs after live validation.
- [ ] Remove or revise docs/UI language that presents `imessage` as legacy or WIP.
- [ ] Add a plugin-inspector fixture or benchmark entry for the bundled `imessage` plugin.
- [ ] Run plugin-inspector against the bundled plugin.
- [ ] Open upstream PR from `omarshahine/openclaw:feat/imsg-plugin-private-api`.
