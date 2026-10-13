/** The structural diff lives in @ih/shared (the change log and the web use it too). */
export {
  DefinitionChangeSchema as ChangeSchema,
  diffDefinitions,
  type DefinitionChange as Change,
} from '@ih/shared';
