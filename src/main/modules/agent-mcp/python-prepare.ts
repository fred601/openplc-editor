import { PLCPou, PLCProjectData } from '@root/types/PLC/open-plc'
import { addPythonLocalVariables } from '@root/utils/python/addPythonLocalVariables'
import { generateSTCode } from '@root/utils/python/generateSTCode'
import { injectPythonCode } from '@root/utils/python/injectPythonCode'

const extractPythonData = (pous: PLCPou[]) =>
  pous
    .filter((pou) => pou.data.body.language === 'python')
    .map((pou) => ({
      name: pou.data.name,
      type: pou.type,
      code: pou.data.body.language === 'python' ? pou.data.body.value : '',
      documentation: pou.data.documentation,
      variables: pou.data.variables,
    }))

/**
 * Same Python rewrite the workspace activity bar runs before compileProgram.
 * CompilerModule does not understand Python POUs; pou-xml drops them.
 */
const prepareProjectDataForCompile = (
  projectData: PLCProjectData,
): { data: PLCProjectData; warnings: string[] } => {
  const warnings: string[] = []
  const hasPython = projectData.pous.some((pou) => pou.data.body.language === 'python')
  if (!hasPython) return { data: projectData, warnings }

  let processed = addPythonLocalVariables(projectData)
  const pythonData = extractPythonData(processed.pous)
  const processedPythonCodes = injectPythonCode(pythonData)
  let pythonIndex = 0
  processed = {
    ...processed,
    pous: processed.pous.map((pou): PLCPou => {
      if (pou.data.body.language !== 'python') return pou
      const source = processedPythonCodes[pythonIndex]
      pythonIndex += 1
      if (!source) return pou
      warnings.push(`POU "${pou.data.name}" 是 Python，已在编译前改写成 ST。`)
      const body = {
        language: 'st' as const,
        value: generateSTCode({
          pouName: pou.data.name,
          allVariables: pou.data.variables,
          processedPythonCode: source,
        }),
      }
      if (pou.type === 'function') return { type: 'function', data: { ...pou.data, body } }
      if (pou.type === 'function-block') return { type: 'function-block', data: { ...pou.data, body } }
      return { type: 'program', data: { ...pou.data, body } }
    }),
  }
  return { data: processed, warnings }
}

export { prepareProjectDataForCompile }
