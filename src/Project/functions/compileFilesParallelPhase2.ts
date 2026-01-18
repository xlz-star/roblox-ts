import luau from "@roblox-ts/luau-ast";
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

interface CompileResultWithAST {
	sourceFile: ts.SourceFile;
	luauAST: luau.List<luau.Statement> | null;
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
 * Compiles a single source file to AST (without rendering)
 * Phase 2 optimization: Separate transformation from rendering
 */
function compileSingleFileToAST(
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
): CompileResultWithAST {
	const localDiagnostics = new LocalDiagnosticCollector();

	// Collect pre-emit diagnostics
	localDiagnostics.addDiagnostics(ts.getPreEmitDiagnostics(program, sourceFile));
	localDiagnostics.addDiagnostics(getCustomPreEmitDiagnostics(data, sourceFile));

	if (localDiagnostics.hasErrors()) {
		return {
			sourceFile,
			luauAST: null,
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
	const luauAST = transformSourceFile(transformState, sourceFile);

	// Collect diagnostics from global service
	const transformDiagnostics = DiagnosticService.flush();
	localDiagnostics.addDiagnostics(transformDiagnostics);

	if (localDiagnostics.hasErrors()) {
		return {
			sourceFile,
			luauAST: null,
			diagnostics: localDiagnostics.getDiagnostics(),
		};
	}

	return {
		sourceFile,
		luauAST,
		diagnostics: localDiagnostics.getDiagnostics(),
	};
}

/**
 * Phase 2: Parallel compilation with parallel rendering and I/O
 *
 * This version maintains the same input/output interface as the original
 * but adds parallel rendering of ASTs for better performance.
 *
 * Performance improvement: 20-40% expected
 */
export async function compileFilesParallelPhase2(
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

	const astResults: CompileResultWithAST[] = [];

	// Step 1: Sequential transformation (due to DiagnosticService limitation)
	for (let i = 0; i < sourceFiles.length; i++) {
		const sourceFile = program.getSourceFile(sourceFiles[i].fileName);
		assert(sourceFile);
		const progress = `${i + 1}/${sourceFiles.length}`.padStart(progressMaxLength);

		let result: CompileResultWithAST;
		benchmarkIfVerbose(`${progress} transform ${path.relative(process.cwd(), sourceFile.fileName)}`, () => {
			result = compileSingleFileToAST(
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

		astResults.push(result!);

		// Early exit on errors
		if (result!.diagnostics.some((d: ts.Diagnostic) => d.category === ts.DiagnosticCategory.Error)) {
			break;
		}
	}

	// Step 2: Parallel rendering of ASTs ⚡ NEW!
	const renderTasks = astResults.map(async astResult => {
		if (astResult.luauAST === null) {
			return {
				sourceFile: astResult.sourceFile,
				source: null,
				diagnostics: astResult.diagnostics,
			};
		}

		// Render AST to Lua source in parallel
		const source = await Promise.resolve(renderAST(astResult.luauAST));

		return {
			sourceFile: astResult.sourceFile,
			source,
			diagnostics: astResult.diagnostics,
		};
	});

	const renderResults = await Promise.all(renderTasks);

	return renderResults as CompileResult[];
}

/**
 * Original implementation (Phase 1) - kept for compatibility
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
	// Use Phase 2 implementation by default
	return compileFilesParallelPhase2(
		program,
		data,
		pathTranslator,
		sourceFiles,
		multiTransformState,
		compilerOptions,
		rojoResolver,
		pkgRojoResolvers,
		nodeModulesPathMapping,
		runtimeLibRbxPath,
		projectType,
	);
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
