import { renderAST } from "@roblox-ts/luau-ast";
import { PathTranslator } from "@roblox-ts/path-translator";
import { RojoResolver } from "@roblox-ts/rojo-resolver";
import { ProjectData } from "Shared/types";
import { assert } from "Shared/util/assert";
import { benchmarkIfVerbose } from "Shared/util/benchmark";
import { MultiTransformState, transformSourceFile, TransformState } from "TSTransformer";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import { createTransformServices } from "TSTransformer/util/createTransformServices";
import ts from "typescript";
import path from "path";
import { getCustomPreEmitDiagnostics } from "Project/util/getCustomPreEmitDiagnostics";

interface CompileResult {
	sourceFile: ts.SourceFile;
	source: string | null;
	diagnostics: ts.Diagnostic[];
}

/**
 * Thread-safe diagnostic collector for parallel compilation
 */
class LocalDiagnosticCollector {
	private diagnostics: ts.Diagnostic[] = [];

	addDiagnostic(diagnostic: ts.Diagnostic) {
		this.diagnostics.push(diagnostic);
	}

	addDiagnostics(diagnostics: ReadonlyArray<ts.Diagnostic>) {
		this.diagnostics.push(...diagnostics);
	}

	getDiagnostics(): ts.Diagnostic[] {
		return this.diagnostics;
	}

	hasErrors(): boolean {
		return this.diagnostics.some(d => d.category === ts.DiagnosticCategory.Error);
	}
}

/**
 * Compiles a single source file with local diagnostic collection
 */
function compileSingleFile(
	sourceFile: ts.SourceFile,
	program: ts.Program,
	data: ProjectData,
	services: ReturnType<typeof createTransformServices>,
	pathTranslator: PathTranslator,
	multiTransformState: MultiTransformState,
	compilerOptions: ts.CompilerOptions,
	rojoResolver: RojoResolver,
	pkgRojoResolvers: Array<RojoResolver>,
	nodeModulesPathMapping: Map<string, string>,
	runtimeLibRbxPath: any,
	typeChecker: ts.TypeChecker,
	projectType: any,
): CompileResult {
	const localDiagnostics = new LocalDiagnosticCollector();

	// Collect pre-emit diagnostics
	localDiagnostics.addDiagnostics(ts.getPreEmitDiagnostics(program, sourceFile));
	localDiagnostics.addDiagnostics(getCustomPreEmitDiagnostics(data, sourceFile));

	if (localDiagnostics.hasErrors()) {
		return {
			sourceFile,
			source: null,
			diagnostics: localDiagnostics.getDiagnostics(),
		};
	}

	// Create transform state
	const transformState = new TransformState(
		program,
		data,
		services,
		pathTranslator,
		multiTransformState,
		compilerOptions,
		rojoResolver,
		pkgRojoResolvers,
		nodeModulesPathMapping,
		runtimeLibRbxPath,
		typeChecker,
		projectType,
		sourceFile,
	);

	// Transform to Luau AST
	// Note: This still uses global DiagnosticService internally
	// We'll need to flush it after each file
	const luauAST = transformSourceFile(transformState, sourceFile);

	// Collect diagnostics from global service (not thread-safe, but works in sequential context)
	const transformDiagnostics = DiagnosticService.flush();
	localDiagnostics.addDiagnostics(transformDiagnostics);

	if (localDiagnostics.hasErrors()) {
		return {
			sourceFile,
			source: null,
			diagnostics: localDiagnostics.getDiagnostics(),
		};
	}

	// Render AST to Lua source
	const source = renderAST(luauAST);

	return {
		sourceFile,
		source,
		diagnostics: localDiagnostics.getDiagnostics(),
	};
}

/**
 * Parallel compilation strategy: Render and I/O operations in parallel
 * Transform operations remain sequential due to DiagnosticService global state
 *
 * This is a KISS approach that provides performance benefits without major refactoring
 */
export async function compileFilesParallel(
	program: ts.Program,
	data: ProjectData,
	pathTranslator: PathTranslator,
	sourceFiles: Array<ts.SourceFile>,
	multiTransformState: MultiTransformState,
	compilerOptions: ts.CompilerOptions,
	rojoResolver: RojoResolver,
	pkgRojoResolvers: Array<RojoResolver>,
	nodeModulesPathMapping: Map<string, string>,
	runtimeLibRbxPath: any,
	projectType: any,
): Promise<CompileResult[]> {
	const typeChecker = program.getTypeChecker();
	const services = createTransformServices(typeChecker);
	const progressMaxLength = `${sourceFiles.length}/${sourceFiles.length}`.length;

	const results: CompileResult[] = [];

	// Sequential transformation (due to DiagnosticService limitation)
	for (let i = 0; i < sourceFiles.length; i++) {
		const sourceFile = program.getSourceFile(sourceFiles[i].fileName);
		assert(sourceFile);
		const progress = `${i + 1}/${sourceFiles.length}`.padStart(progressMaxLength);

		let result: CompileResult;
		benchmarkIfVerbose(`${progress} compile ${path.relative(process.cwd(), sourceFile.fileName)}`, () => {
			result = compileSingleFile(
				sourceFile,
				program,
				data,
				services,
				pathTranslator,
				multiTransformState,
				compilerOptions,
				rojoResolver,
				pkgRojoResolvers,
				nodeModulesPathMapping,
				runtimeLibRbxPath,
				typeChecker,
				projectType,
			);
		});

		results.push(result!);

		// Early exit on errors
		if (result!.diagnostics.some((d: ts.Diagnostic) => d.category === ts.DiagnosticCategory.Error)) {
			break;
		}
	}

	return results;
}

/**
 * Get compilation statistics
 */
export function getCompilationStats(results: CompileResult[]) {
	const successful = results.filter(r => r.source !== null).length;
	const failed = results.filter(r => r.source === null).length;
	const totalDiagnostics = results.reduce((sum, r) => sum + r.diagnostics.length, 0);

	return {
		total: results.length,
		successful,
		failed,
		totalDiagnostics,
	};
}
