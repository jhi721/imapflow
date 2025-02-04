'use strict';

const { decodePath, encodePath, normalizePath } = require('../tools.js');
const { specialUse } = require('../special-use');

// Lists mailboxes from server
module.exports = async (connection, reference, mailbox, options) => {
    options = options || {};

    let listCommand = connection.capabilities.has('XLIST') && !connection.capabilities.has('SPECIAL-USE') ? 'XLIST' : 'LIST';

    let response;
    try {
        let flagsSeen = new Set();
        let entries = [];

        let runList = async (reference, mailbox) => {
            response = await connection.exec(listCommand, [encodePath(connection, reference), encodePath(connection, mailbox)], {
                untagged: {
                    [listCommand]: async untagged => {
                        if (!untagged.attributes || !untagged.attributes.length) {
                            return;
                        }

                        let entry = {
                            path: normalizePath(connection, decodePath(connection, (untagged.attributes[2] && untagged.attributes[2].value) || '')),
                            pathAsListed: (untagged.attributes[2] && untagged.attributes[2].value) || '',
                            flags: new Set(untagged.attributes[0].map(entry => entry.value)),
                            delimiter: untagged.attributes[1] && untagged.attributes[1].value,
                            listed: true
                        };

                        if (listCommand === 'XLIST' && entry.flags.has('\\Inbox')) {
                            // XLIST specific flag, ignore
                            entry.flags.delete('\\Inbox');
                            if (entry.path !== 'INBOX') {
                                // XLIST may use localised inbox name
                                entry.specialUse = '\\Inbox';
                            }
                        }

                        if (entry.path.toUpperCase() === 'INBOX') {
                            entry.specialUse = '\\Inbox';
                        }

                        if (entry.delimiter && entry.path.charAt(0) === entry.delimiter) {
                            entry.path = entry.path.slice(1);
                        }

                        entry.parentPath = entry.delimiter && entry.path ? entry.path.substr(0, entry.path.lastIndexOf(entry.delimiter)) : '';
                        entry.parent = entry.delimiter ? entry.path.split(entry.delimiter) : [entry.path];
                        entry.name = entry.parent.pop();

                        let specialUseFlag = specialUse(connection.capabilities.has('XLIST') || connection.capabilities.has('SPECIAL-USE'), entry);
                        if (specialUseFlag && !flagsSeen.has(specialUseFlag)) {
                            entry.specialUse = specialUseFlag;
                        }

                        entries.push(entry);
                    }
                }
            });
            response.next();
        };

        let normalizedReference = normalizePath(connection, reference || '');
        await runList(normalizedReference, normalizePath(connection, mailbox || '', true));

        if (options.listOnly) {
            return entries;
        }

        if (normalizedReference && !entries.find(entry => entry.specialUse === '\\Inbox')) {
            // INBOX was most probably not included in the listing if namespace was used
            await runList('', 'INBOX');
        }

        response = await connection.exec(
            'LSUB',
            [encodePath(connection, normalizePath(connection, reference || '')), encodePath(connection, normalizePath(connection, mailbox || '', true))],
            {
                untagged: {
                    LSUB: async untagged => {
                        if (!untagged.attributes || !untagged.attributes.length) {
                            return;
                        }

                        let entry = {
                            path: normalizePath(connection, decodePath(connection, (untagged.attributes[2] && untagged.attributes[2].value) || '')),
                            pathAsListed: (untagged.attributes[2] && untagged.attributes[2].value) || '',
                            flags: new Set(untagged.attributes[0].map(entry => entry.value)),
                            delimiter: untagged.attributes[1] && untagged.attributes[1].value,
                            subscribed: true
                        };

                        if (entry.path.toUpperCase() === 'INBOX') {
                            entry.specialUse = '\\Inbox';
                        }

                        if (entry.delimiter && entry.path.charAt(0) === entry.delimiter) {
                            entry.path = entry.path.slice(1);
                        }

                        entry.parentPath = entry.delimiter && entry.path ? entry.path.substr(0, entry.path.lastIndexOf(entry.delimiter)) : '';
                        entry.parent = entry.delimiter ? entry.path.split(entry.delimiter) : [entry.path];
                        entry.name = entry.parent.pop();

                        let existing = entries.find(existing => existing.path === entry.path);
                        if (existing) {
                            existing.subscribed = true;
                            entry.flags.forEach(flag => existing.flags.add(flag));
                        } else {
                            // ignore non-listed folders
                            /*
                            let specialUseFlag = specialUse(connection.capabilities.has('XLIST') || connection.capabilities.has('SPECIAL-USE'), entry);
                            if (specialUseFlag && !flagsSeen.has(specialUseFlag)) {
                                entry.specialUse = specialUseFlag;
                            }
                            entries.push(entry);
                            */
                        }
                    }
                }
            }
        );
        response.next();

        let inboxEntry = entries.find(entry => entry.specialUse === '\\Inbox');
        if (inboxEntry && !inboxEntry.subscribed) {
            // override server settings and make INBOX always as subscribed
            inboxEntry.subscribed = true;
        }

        ['\\Drafts', '\\Junk', '\\Sent', '\\Trash'].forEach(specialUseFlag => {
            // try to ensure that we have most needed special use mailboxes detected
            if (entries.find(entry => entry.specialUse === specialUseFlag)) {
                return;
            }

            // special use mailbox not found? try again
            let match = entries.find(entry => !entry.specialUse && specialUse(false, entry) === specialUseFlag);
            if (match) {
                match.specialUse = specialUseFlag;
            }
        });

        return entries;
    } catch (err) {
        connection.log.warn({ msg: 'Failed to list folders', err, cid: connection.id });
        throw err;
    }
};
