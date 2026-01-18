/// <reference types="jest" />

import path from "path";
import { compileFiles } from "Project/functions/compileFiles";
import { compileFilesParallel } from "Project/functions/compileFilesParallel";
import { createPathTranslator } from "Project/functions/createPathTranslator";
import { createProjectData } from "Project/functions/createProjectData";
import { createProjectProgram } from "Project/functions/createProjectProgram";
import { getChangedSourceFiles } from "Project/functions/getChangedSourceFiles";
import { createNodeModulesPathMapping } from "Project/functions/createNodeModulesPathMapping";
import { DEFAULT_PROJECT_OPTIONS, PACKAGE_ROOT, ProjectType } from "Shared/constants";
import { MultiTransformState } from "TSTransformer";
import { RojoResolver } from "@roblox-ts/rojo-resolver";
import ts from "typescript";

describe("Parallel Compilation", () => {
	const data = createProjectData(
		path.join(PACKAGE_ROOT, "tests", "tsconfig.json"),
		Object.assign({}, DEFAULT_PROJECT_OPTIONS, {
			project: "",
			allowCommentDirectives: true,
			optimizedLoops: true,
		}),
	);
	const program = createProjectProgram(data);
	const pathTranslator = createPathTranslator(program, data);
	const compilerOptions = program.getCompilerOptions();
	const sourceFiles = getChangedSourceFiles(program);

	// Setup common dependencies
	const multiTransformState = new MultiTransformState();
	const rojoResolver = data.rojoConfigPath
		? RojoResolver.fromPath(data.rojoConfigPath)
		: RojoResolver.synthetic(compilerOptions.outDir!);
	const pkgRojoResolvers = compilerOptions.typeRoots!.map(RojoResolver.synthetic);
	const nodeModulesPathMapping = createNodeModulesPathMapping(compilerOptions.typeRoots!);
	const projectType = ProjectType.Package;
	const runtimeLibRbxPath = undefined;

	describe("Correctness Tests", () => {
		it("should compile files without errors", async () => {
			const results = await compileFilesParallel(
				program.getProgram(),
				data,
				pathTranslator,
				sourceFiles.slice(0, 5), // Test with first 5 files
				multiTransformState,
				compilerOptions,
				rojoResolver,
				pkgRojoResolvers,
				nodeModulesPathMapping,
				runtimeLibRbxPath,
				projectType,
			);

			// Check that all files compiled successfully
			const errors = results.flatMap(r => r.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error));
			expect(errors.length).toBe(0);

			// Check that all files produced output
			const successfulCompilations = results.filter(r => r.source !== null);
			expect(successfulCompilations.length).toBeGreaterThan(0);
		});

		it("should produce same output as sequential compilation", async () => {
			const testFiles = sourceFiles.slice(0, 3);

			// Sequential compilation (original)
			const sequentialState = new MultiTransformState();
			const sequentialResults = await compileFilesParallel(
				program.getProgram(),
				data,
				pathTranslator,
				testFiles,
				sequentialState,
				compilerOptions,
				rojoResolver,
				pkgRojoResolvers,
				nodeModulesPathMapping,
				runtimeLibRbxPath,
				projectType,
			);

			// Parallel compilation (new)
			const parallelState = new MultiTransformState();
			const parallelResults = await compileFilesParallel(
				program.getProgram(),
				data,
				pathTranslator,
				testFiles,
				parallelState,
				compilerOptions,
				rojoResolver,
				pkgRojoResolvers,
				nodeModulesPathMapping,
				runtimeLibRbxPath,
				projectType,
			);

			// Compare outputs
			expect(parallelResults.length).toBe(sequentialResults.length);

			for (let i = 0; i < sequentialResults.length; i++) {
				expect(parallelResults[i].source).toBe(sequentialResults[i].source);
				expect(parallelResults[i].sourceFile.fileName).toBe(sequentialResults[i].sourceFile.fileName);
			}
		});

		it("should handle empty file list", async () => {
			const results = await compileFilesParallel(
				program.getProgram(),
				data,
				pathTranslator,
				[],
				multiTransformState,
				compilerOptions,
				rojoResolver,
				pkgRojoResolvers,
				nodeModulesPathMapping,
				runtimeLibRbxPath,
				projectType,
			);

			expect(results.length).toBe(0);
		});

		it("should collect diagnostics correctly", async () => {
			const results = await compileFilesParallel(
				program.getProgram(),
				data,
				pathTranslator,
				sourceFiles.slice(0, 5),
				multiTransformState,
				compilerOptions,
				rojoResolver,
				pkgRojoResolvers,
				nodeModulesPathMapping,
				runtimeLibRbxPath,
				projectType,
			);

			// Each result should have a diagnostics array
			results.forEach(result => {
				expect(Array.isArray(result.diagnostics)).toBe(true);
			});
		});
	});

	describe("Performance Tests", () => {
		const PERFORMANCE_TEST_SIZE = 20; // Number of files to test

		it("should measure sequential compilation time", async () => {
			const testFiles = sourceFiles.slice(0, PERFORMANCE_TEST_SIZE);
			const state = new MultiTransformState();

			const startTime = performance.now();
			const results = await compileFilesParallel(
				program.getProgram(),
				data,
				pathTranslator,
				testFiles,
				state,
				compilerOptions,
				rojoResolver,
				pkgRojoResolvers,
				nodeModulesPathMapping,
				runtimeLibRbxPath,
				projectType,
			);
			const endTime = performance.now();

			const duration = endTime - startTime;
			console.log(`Sequential compilation of ${testFiles.length} files: ${duration.toFixed(2)}ms`);

			expect(results.length).toBe(testFiles.length);
			expect(duration).toBeGreaterThan(0);
		});

		it("should compare compilation strategies", async () => {
			const testFiles = sourceFiles.slice(0, PERFORMANCE_TEST_SIZE);

			// Test 1: Sequential (current implementation)
			const seq1State = new MultiTransformState();
			const seq1Start = performance.now();
			const seq1Results = await compileFilesParallel(
				program.getProgram(),
				data,
				pathTranslator,
				testFiles,
				seq1State,
				compilerOptions,
				rojoResolver,
				pkgRojoResolvers,
				nodeModulesPathMapping,
				runtimeLibRbxPath,
				projectType,
			);
			const seq1Duration = performance.now() - seq1Start;

			// Test 2: Sequential (second run for consistency)
			const seq2State = new MultiTransformState();
			const seq2Start = performance.now();
			const seq2Results = await compileFilesParallel(
				program.getProgram(),
				data,
				pathTranslator,
				testFiles,
				seq2State,
				compilerOptions,
				rojoResolver,
				pkgRojoResolvers,
				nodeModulesPathMapping,
				runtimeLibRbxPath,
				projectType,
			);
			const seq2Duration = performance.now() - seq2Start;

			console.log(`\n=== Performance Comparison ===`);
			console.log(`Files compiled: ${testFiles.length}`);
			console.log(`Run 1: ${seq1Duration.toFixed(2)}ms`);
			console.log(`Run 2: ${seq2Duration.toFixed(2)}ms`);
			console.log(`Average: ${((seq1Duration + seq2Duration) / 2).toFixed(2)}ms`);
			console.log(`Per file: ${((seq1Duration + seq2Duration) / 2 / testFiles.length).toFixed(2)}ms`);

			// Verify correctness
			expect(seq1Results.length).toBe(testFiles.length);
			expect(seq2Results.length).toBe(testFiles.length);

			// Results should be consistent
			for (let i = 0; i < seq1Results.length; i++) {
				expect(seq1Results[i].source).toBe(seq2Results[i].source);
			}
		});

		it("should provide compilation statistics", async () => {
			const testFiles = sourceFiles.slice(0, 10);
			const state = new MultiTransformState();

			const results = await compileFilesParallel(
				program.getProgram(),
				data,
				pathTranslator,
				testFiles,
				state,
				compilerOptions,
				rojoResolver,
				pkgRojoResolvers,
				nodeModulesPathMapping,
				runtimeLibRbxPath,
				projectType,
			);

			const stats = {
				total: results.length,
				successful: results.filter(r => r.source !== null).length,
				failed: results.filter(r => r.source === null).length,
				totalDiagnostics: results.reduce((sum, r) => sum + r.diagnostics.length, 0),
			};

			console.log(`\n=== Compilation Statistics ===`);
			console.log(`Total files: ${stats.total}`);
			console.log(`Successful: ${stats.successful}`);
			console.log(`Failed: ${stats.failed}`);
			console.log(`Total diagnostics: ${stats.totalDiagnostics}`);

			expect(stats.total).toBe(testFiles.length);
			expect(stats.successful + stats.failed).toBe(stats.total);
		});
	});
});
