import { 
	Range,
	Position,
	CompletionItemProvider,
	TextDocument,
	CancellationToken,
	CompletionContext,
	ProviderResult,
	CompletionItem,
	Location,
	SymbolInformation,
	DocumentSymbol,
	CompletionItemKind,
	SnippetString,
	TextEdit,
	ExtensionContext,
	commands,
	languages,
	Uri,
	workspace,
	SymbolKind,
	TextDocumentChangeEvent,
} from 'vscode';

import executeCommand = commands.executeCommand; 
import registerCompletionItemProvider = languages.registerCompletionItemProvider;
import openTextDocument = workspace.openTextDocument;
import { channel } from 'diagnostics_channel';

class CCompletionItemProvider implements CompletionItemProvider {

	private readonly maxContextSize = 128;
	private readonly updateInterval = 5000;

	private includes: Map<Uri, Set<Uri>> = new Map();
	private funcs: Map<Uri, Map<string, {name: string, firstArgIsPointer: boolean, multiArg: boolean}[]>> = new Map();

	private static getIncludePositions(document: TextDocument, range?: Range): Position[] {
		if (range === undefined) {
			range = new Range(new Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
		}
		let includePositions: Position[] = [];
		for (let i = range.start.line; i <= range.end.line; i++) {
			let line = document.lineAt(i).text.trimStart();
			if (line.startsWith('#') && line.slice(1).trimStart().startsWith('include')) {
				let endingSpaces = 0
				while (line.at(line.length - endingSpaces - 1) === ' ') endingSpaces++;
				includePositions.push(document.lineAt(i).range.end.translate({ characterDelta: -endingSpaces-1 }))
			}
		}

		return includePositions;
	}

	private static async getIncludeUri(uri: Uri, position: Position): Promise<Uri> {
	 	let locations = await executeCommand<Location[]>("vscode.executeDefinitionProvider", uri, position);
		return locations[0]?.uri;
	}

	public async onNewDocument(uri: Uri): Promise<void> {
		await this.setFuncs(uri);

		await this.setIncludes(uri);

		setInterval(() => this.setIncludes(uri), this.updateInterval)
	}

	public async onDocumentChange(e: TextDocumentChangeEvent): Promise<void> {
		await this.setFuncs(e.document.uri);
		await Promise.all(e.contentChanges.map(change => {
			this.setIncludes(e.document.uri, change.range)
		}));
	}

	private async setIncludes(uri: Uri, range?: Range): Promise<void> {
		let document = await openTextDocument(uri);

		if (!range) await this.setFuncs(uri);

		let includePositions = CCompletionItemProvider.getIncludePositions(document, range);

		let includeUris = new Set<Uri>();
		if (range && this.includes.get(uri)) includeUris = this.includes.get(uri)!;

		(await Promise.all(includePositions.map(val => CCompletionItemProvider.getIncludeUri(uri, val).then(
			async includeUri => {
				if (includeUri) await this.setFuncs(includeUri);
				return includeUri;
			}
		)))).forEach(includeUri => { if (includeUri) includeUris.add(includeUri) });
		includeUris.add(uri);
		this.includes.set(uri, includeUris);
	}

	private async setFuncs(uri: Uri): Promise<void> {
		let funcs = (await executeCommand<SymbolInformation[] | DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", uri))
			.filter(symbol => symbol.kind === SymbolKind.Function)
			.map(val => this.prepareFunc(val.name))
			.filter(val => val.argsCount > 0)
			.reduce<Map<string, {name: string, firstArgIsPointer: boolean, multiArg: boolean}[]>>((prev, val) => 
				prev.set(val.firstArgType!, (prev.get(val.firstArgType!) ?? []).concat(
					{name: val.name, firstArgIsPointer: val.firstArgIsPointer!, multiArg: val.argsCount > 1}
				))
			, new Map());

		this.funcs.set(uri, funcs);
	}

	provideCompletionItems(
		document: TextDocument,
		position: Position,
		token: CancellationToken,
		context: CompletionContext
	): ProviderResult<CompletionItem[]> {

		if  (context.triggerCharacter != ".") return;

		return this.generateCompletionItems(document, position);

	}

	private async generateCompletionItems(document: TextDocument, position: Position): Promise<CompletionItem[]> {
		if (!this.includes.has(document.uri)) await this.onNewDocument(document.uri);
		let offset = document.offsetAt(position) - 1;
		let textContext = document.getText(new Range(
			document.positionAt(offset - this.maxContextSize >= 0 ? offset - this.maxContextSize : 0),
			position.translate(undefined, -1)
		));
		let tokenBoundaries = this.getTokenBoundaries(textContext);
		let tokenRange = new Range(document.positionAt(offset - tokenBoundaries[0]), document.positionAt(offset));
		let goToDefinitionPosition = document.positionAt(offset - tokenBoundaries[1]);

		let defLocations = await executeCommand<Location[]>("vscode.executeDefinitionProvider", document.uri, goToDefinitionPosition);
		let defDocument = await openTextDocument(defLocations[0].uri);
		let defLine = defDocument.lineAt(defLocations[0].range.start.line);
		let tokenIsPointer = false;
		let char = defLocations[0].range.start.character - 1;
		while (defLine.text.charAt(char) === ' ') char--;
		if (defLine.text.charAt(char) === '*') {
			tokenIsPointer = true;
			char--;
			while (defLine.text.charAt(char) === ' ') char--;
		}
		let type = defDocument.getText(defDocument.getWordRangeAtPosition(new Position(defLine.lineNumber, char)));

		let completions: Map<string, CompletionItem> = new Map();
		this.includes.get(document.uri)!.forEach(val => {
			(this.funcs.get(val)!.get(type) ?? [])
			.forEach(val => completions.set(val.name, this.makeCompletion(document, tokenRange, tokenIsPointer, val)))
		});

		return Array.from(completions.values());
	}

	getTokenBoundaries(text: string): number[] {
		let cur_char = text.length-1;
		let res = [-1, -1];
		if (text[cur_char] === ')') {
			let brackets = 1;
			while (brackets != 0) {
				cur_char -= 1;
				if (cur_char < 0) return res;
				if (text[cur_char] === ')') brackets++;
				else if (text[cur_char] === '(') brackets--;
			}
		}
		res[1] = text.length - cur_char;
		const stop_chars = [' ', '\n', ';', '*', '+', '-', '=', '/', '&', '%'];
		let brackets = 0;
		while (brackets >= 0) {
			cur_char -= 1;
			if (cur_char < 0) return res;
			if (text[cur_char] === ')') brackets++;
			else if (text[cur_char] === '(') brackets--;
			else if (stop_chars.includes(text[cur_char])) break;
		}
		res[0] = text.length - cur_char - 1;

		return res;
	}

	prepareFunc(func: string): { name: string, firstArgType?: string, firstArgIsPointer?: boolean, argsCount: number} {
		let name = func.slice(0, func.indexOf('('))

		let args = func.slice(func.indexOf('(') + 1, func.lastIndexOf(')')).split(',');

		if (args.length === 1 && args[0].trim() === '') return { name: name, argsCount: 0};

		let firstArgTokens = args[0].split(" ").filter(val => val !== '');
		let firstArgIsPointer = firstArgTokens[firstArgTokens.length - 1] === '*';
		let firstArgType = firstArgIsPointer? firstArgTokens[firstArgTokens.length - 2] : firstArgTokens[firstArgTokens.length - 1];

		return {
			name: name,
			firstArgType: firstArgType,
			firstArgIsPointer: firstArgIsPointer,
			argsCount: args.length
		}
	}

	makeCompletion(
		document: TextDocument,
		tokenRange: Range,
		tokenIsPointer: boolean,
		func: {
			name: string,
			firstArgIsPointer: boolean,
			multiArg: boolean
		}
	): CompletionItem {

		let completion = new CompletionItem(func.name)
		completion.kind = CompletionItemKind.Method;
		completion.insertText = new SnippetString()
		let prefix = "";
		if (tokenIsPointer && !func.firstArgIsPointer) prefix = "*";
		else if (func.firstArgIsPointer && !tokenIsPointer) prefix = "&";
		completion.insertText.appendText(func.name + '(' + prefix + document.getText(tokenRange));
		if (func.multiArg) completion.insertText.appendText(", ").appendTabstop();
		completion.insertText.appendText(")");
		completion.additionalTextEdits = [TextEdit.delete(tokenRange.with({ end: tokenRange.end.translate(0, 1) }))];

		return completion;
	}
}

export function activate(context: ExtensionContext) {

	let cCompletionItemProvider = new CCompletionItemProvider();

	//workspace.onDidChangeTextDocument((e) => cCompletionItemProvider.onDocumentChange(e));

	context.subscriptions.push(registerCompletionItemProvider(
		"c", cCompletionItemProvider, '.'
	));
}


export function deactivate() {}
