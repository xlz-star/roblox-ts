import { renderAST } from "@roblox-ts/luau-ast";
import { PathTranslator } from "@roblox-ts/path-translator";
import { RojoResolver } from "@roblox-ts/rojo-resolver";
import fs from "fs-extra";
import path from "path";
import { compileFilesParallelPhase2 } from "Project/functions/compileFilesParallelPhase2";
import { ProjectData } from "Shared/types";
import { benchmarkIfVerbose } from "Shared/util/benchmark";
import { MultiTransformState } from "TSTransformer";
import { DiagnosticService } from "TSTransformer/classes/DiagnosticService";
import ts from "typescript";

/**
 * Phase 2: Complete parallel compilation with parallel I/O
 *
 * This function adds parallel file writing on top of parallel rendering
 * Expected performance improvement: 20-40%
 */
export async function compileAndWriteFilesParallel(
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
): Promise<ts.EmitResult> {
	const startTime = Date.now();

	// Step 1 & 2: Transform and parallel render
	const results = await compileFilesParallelPhase2(
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

	// Collect all diagnostics
	const allDiagnostics: ts.Diagnostic[] = [];
	results.forEach((result: any) => {
		allDiagnostics.push(...result.diagnostics);
	});

	// Check for errors
	const hasErrors = allDiagnostics.some(d => d.category === ts.DiagnosticCategory.Error);

	if (hasErrors) {
		return {
			emitSkipped: true,
			diagnostics: allDiagnostics,
		};
	}

	// Step 3: Parallel file writing ⚡ NEW!
	const writeTasks = results.map(async (result: any) => {
		if (result.source) {
			const outPath = pathTranslator.getOutputPath(result.sourceFile.fileName);

			// Check if we need to write (skip if content is the same)
			const shouldWrite =
				!data.projectOptions.writeOnlyChanged ||
				!(await fs.pathExists(outPath)) ||
				(await fs.readFile(outPath, "utf8")) !== result.source;

			if (shouldWrite) {
				await fs.outputFile(outPath, result.source);
				return outPath;
			}
		}
		return null;
	});

	const written = await Promise.all(writeTasks);
	const emittedFiles = written.filter((p): p is string => p !== null);

	const endTime = Date.now();
	const totalTime = endTime - startTime;

	// Output statistics
	const stats = {
		total: results.length,
		successful: results.filter((r: any) => r.source !== null).length,
		failed: results.filter((r: any) => r.source === null).length,
		totalDiagnostics: allDiagnostics.length,
	};

	console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    编译统计 (阶段 2 - 并行优化)                  ║
╚══════════════════════════════════════════════════════════════════╝

📊 文件统计:
  • 总文件数: ${stats.total}
  • 成功: ${stats.successful}
  • 失败: ${stats.failed}
  • 诊断信息: ${stats.totalDiagnostics}

⏱️  性能:
  • 总时间: ${totalTime}ms
  • 平均: ${(totalTime / stats.total).toFixed(2)}ms/文件

💾 输出:
  • 写入文件: ${emittedFiles.length}
  • 跳过文件: ${stats.successful - emittedFiles.length}

⚡ 优化:
  • 并行渲染: ✅
  • 并行写入: ✅
`);

	return {
		emitSkipped: false,
		diagnostics: allDiagnostics,
		emittedFiles,
	};
}
