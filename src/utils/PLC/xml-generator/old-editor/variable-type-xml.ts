import { PLCVariable } from '@root/types/PLC/open-plc'

type EditorType = PLCVariable['type']

const baseTypeNode = (base: { definition: 'base-type' | 'user-data-type'; value: string }) => {
  if (base.definition === 'user-data-type') {
    return { derived: { '@name': base.value } }
  }
  const value = base.value === 'string' ? 'string' : base.value.toUpperCase()
  return { [value]: '' }
}

/**
 * Encode an editor variable type as an IEC 61131-10 `type` element.
 * Resource global variables used to call `type.value.toUpperCase()`, which
 * drops array and derived types. POU variables already encode those forms.
 */
const editorVariableTypeToXml = (type: EditorType): Record<string, unknown> => {
  if (type.definition === 'array') {
    return {
      array: {
        dimension: type.data.dimensions.map((dimension) => {
          const [lower, upper] = dimension.dimension.split('..')
          return { '@lower': lower ?? '', '@upper': upper ?? '' }
        }),
        baseType: baseTypeNode(type.data.baseType),
      },
    }
  }

  if (type.definition === 'derived' || type.definition === 'user-data-type') {
    return { derived: { '@name': type.value } }
  }

  return baseTypeNode({ definition: 'base-type', value: type.value })
}

export { editorVariableTypeToXml }
