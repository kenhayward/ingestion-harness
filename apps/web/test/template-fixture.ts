/** A valid template definition (version 2) used across editor tests. */
export const validDefinition = () => ({
  id: 'letter',
  version: 2,
  name: 'Letter',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: {
    fields: [{ id: 'sender', type: 'text' }],
    tables: [
      {
        id: 'lines',
        columns: [
          { id: 'item', type: 'text' },
          { id: 'qty', type: 'list' },
        ],
      },
    ],
  },
  pipeline: [
    { type: 'extract', id: 'head', fields: ['sender'], sections: ['all'] },
    { type: 'extract', id: 'rows', table: 'lines', sections: ['all'] },
  ],
});
