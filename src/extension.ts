// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';


class CCompletionItemProvider implements vscode.CompletionItemProvider {
	provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem>> {
		let regex = new RegExp("\\w[\\w\\.\\(\\)]*[\\w\\)]|\\w");
		let regex_no_brackets = new RegExp("\\w[\\w\\.]*\\w|\\w");
		let offset = document.offsetAt(position);
		let word_range = document.getWordRangeAtPosition(document.positionAt(offset - 1), regex);
		let word_range_no_brackets = document.getWordRangeAtPosition(word_range?.start!, regex_no_brackets);
		return vscode.commands.executeCommand<vscode.Location[]>("vscode.executeDefinitionProvider", document.uri, word_range_no_brackets?.end).then(
			def_location => {
				console.log(def_location);
				let type = document.getText(document.getWordRangeAtPosition(document.positionAt(document.offsetAt(def_location[0].range.start)-2)))
				console.log(type);
				return vscode.commands.executeCommand<vscode.SymbolInformation[] | vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", document.uri).then(
					symbols => {
						let completions = new vscode.CompletionList();
						symbols.filter(value => value.kind == 11).forEach(value => {
							let line_text = value.name;
							let open_bracket_index = line_text.indexOf("(");
							let close_bracket_index = line_text.lastIndexOf(")");
							if (close_bracket_index <= open_bracket_index + 1) {
								return;
							}
							let args = line_text.substring(open_bracket_index + 1, close_bracket_index).split(",");
							let first_arg_type = args[0];
							let first_arg_type_list = first_arg_type.split(" ");
							let arg_strart = "(";
							if (first_arg_type_list[first_arg_type_list.length-1].includes("*")) {
								first_arg_type = first_arg_type_list[first_arg_type_list.length-2];
								arg_strart += "&";
							} else {
								first_arg_type = first_arg_type_list[first_arg_type_list.length-1];
							}
							if (first_arg_type == type) {
								let completion = new vscode.CompletionItem(line_text)
								completion.kind = vscode.CompletionItemKind.Method;
								let variable = document.getText(word_range);
								completion.insertText = new vscode.SnippetString()
								completion.insertText.appendText(line_text.split("(")[0] + arg_strart + variable);
								if (args.length > 1) completion.insertText.appendText(", ").appendTabstop();
								completion.insertText.appendText(")");
								completion.additionalTextEdits = [];
								completion.additionalTextEdits.push(vscode.TextEdit.delete(word_range?.with(undefined, word_range.end.with(undefined, word_range.end.character+1))!))
								completions.items.push(completion);
							}
						});
						return completions;
					}
				);
			}
		);

		
	}
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
		"c", new CCompletionItemProvider(), '.'
	));
}

// This method is called when your extension is deactivated
export function deactivate() {}
