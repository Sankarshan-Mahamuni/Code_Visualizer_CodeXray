import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

class JavaTracer {
    private static final List<Map<String, Object>> events = new ArrayList<>();
    private static final Map<String, Object> variables = new LinkedHashMap<>();
    private static final StringBuilder programOutput = new StringBuilder();
    private static final String moduleName = "<module>";
    private static final String moduleFrameId = "f1";
    private static int step = 0;
    private static int lastLine = 1;

    private static Map<String, Object> emptyMap() {
        return new LinkedHashMap<>();
    }

    private static List<Object> emptyList() {
        return new ArrayList<>();
    }

    private static List<Object> callStack() {
        List<Object> stack = new ArrayList<>();
        stack.add(map("frameId", moduleFrameId, "parentFrameId", null, "function", moduleName));
        return stack;
    }

    private static Map<String, Object> valueObject(Object value) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (value == null) {
            out.put("type", "None");
            out.put("value", null);
            return out;
        }
        if (value instanceof Boolean) {
            out.put("type", "bool");
            out.put("value", value);
            return out;
        }
        if (value instanceof Integer || value instanceof Long || value instanceof Short || value instanceof Byte) {
            out.put("type", "int");
            out.put("value", ((Number) value).intValue());
            return out;
        }
        if (value instanceof Double || value instanceof Float) {
            out.put("type", "float");
            out.put("value", ((Number) value).doubleValue());
            return out;
        }
        if (value instanceof String) {
            out.put("type", "str");
            out.put("value", value);
            return out;
        }
        out.put("type", value.getClass().getSimpleName());
        out.put("value", String.valueOf(value));
        return out;
    }

    private static Map<String, Object> variableSnapshot() {
        Map<String, Object> snapshot = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : variables.entrySet()) {
            snapshot.put(entry.getKey(), valueObject(entry.getValue()));
        }
        return snapshot;
    }

    private static void addEvent(String eventType, int line, Map<String, Object> extra) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("step", step);
        event.put("line", line);
        event.put("event", eventType);
        event.put("function", moduleName);
        event.put("frameId", moduleFrameId);
        event.put("variables", variableSnapshot());
        event.put("references", emptyMap());
        event.put("objects", emptyMap());
        event.put("callStack", callStack());
        if (extra != null) {
            event.putAll(extra);
        }
        events.add(event);
        step += 1;
        lastLine = Math.max(lastLine, line);
    }

    private static void setVariable(String name, Object value) {
        variables.put(name, value);
    }

    private static Object convertStringValue(String raw) {
        String text = raw.trim();
        if (text.isEmpty()) {
            return "";
        }
        if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
            return text.substring(1, text.length() - 1);
        }
        if (text.equalsIgnoreCase("true")) {
            return true;
        }
        if (text.equalsIgnoreCase("false")) {
            return false;
        }
        if (text.matches("[-+]?\\d+")) {
            return Integer.parseInt(text);
        }
        if (text.matches("[-+]?\\d+\\.\\d+")) {
            return Double.parseDouble(text);
        }
        if (variables.containsKey(text)) {
            return variables.get(text);
        }
        return text;
    }

    private static int precedence(String op) {
        if (op.equals("||")) return 1;
        if (op.equals("&&")) return 2;
        if (op.equals("==") || op.equals("!=") || op.equals(">") || op.equals("<") || op.equals(">=") || op.equals("<=")) return 3;
        if (op.equals("+") || op.equals("-")) return 4;
        if (op.equals("*") || op.equals("/") || op.equals("%")) return 5;
        return 99;
    }

    private static boolean isInsideQuotes(String expr, int index) {
        boolean inSingle = false;
        boolean inDouble = false;
        for (int i = 0; i < expr.length(); i++) {
            char ch = expr.charAt(i);
            if (ch == '\'' && !inDouble) {
                inSingle = !inSingle;
            }
            if (ch == '"' && !inSingle) {
                inDouble = !inDouble;
            }
            if (i == index) {
                return inSingle || inDouble;
            }
        }
        return false;
    }

    private static int findTopLevelOperator(String expr, String op) {
        int depth = 0;
        for (int i = 0; i < expr.length(); i++) {
            char ch = expr.charAt(i);
            if (ch == '(' || ch == '[' || ch == '{') {
                depth += 1;
                continue;
            }
            if (ch == ')' || ch == ']' || ch == '}') {
                depth -= 1;
                continue;
            }
            if (depth == 0 && !isInsideQuotes(expr, i) && expr.startsWith(op, i)) {
                if (op.equals("=") && !expr.substring(0, i).trim().endsWith("!")) {
                    // ignore assignment markers in expressions.
                }
                return i;
            }
        }
        return -1;
    }

    private static BinaryOp findBestOperator(String expr) {
        String[] ops = {"&&", "||", "==", "!=", ">=", "<=", ">", "<", "+", "-", "*", "/", "%"};
        BinaryOp best = null;
        for (String op : ops) {
            int index = findTopLevelOperator(expr, op);
            if (index >= 0) {
                if (best == null || precedence(op) < precedence(best.operator)) {
                    String left = expr.substring(0, index).trim();
                    String right = expr.substring(index + op.length()).trim();
                    best = new BinaryOp(op, left, right);
                }
            }
        }
        return best;
    }

    private static Map<String, Object> expressionMap(String expr) {
        expr = expr.trim();
        if (expr.isEmpty()) {
            return map("kind", "constant", "value", "");
        }
        if (expr.matches("[-+]?\\d+")) {
            return map("kind", "constant", "value", Integer.parseInt(expr));
        }
        if (expr.matches("[-+]?\\d+\\.\\d+")) {
            return map("kind", "constant", "value", Double.parseDouble(expr));
        }
        if ((expr.startsWith("\"") && expr.endsWith("\"")) || (expr.startsWith("'") && expr.endsWith("'"))) {
            return map("kind", "constant", "value", expr.substring(1, expr.length() - 1));
        }
        if (expr.equalsIgnoreCase("true") || expr.equalsIgnoreCase("false")) {
            return map("kind", "constant", "value", Boolean.parseBoolean(expr));
        }
        if (expr.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            return map("kind", "name", "name", expr);
        }
        if (expr.startsWith("(") && expr.endsWith(")") && expr.length() >= 2) {
            return expressionMap(expr.substring(1, expr.length() - 1));
        }
        BinaryOp op = findBestOperator(expr);
        if (op != null) {
            Map<String, Object> left = expressionMap(op.left);
            Map<String, Object> right = expressionMap(op.right);
            if (op.operator.matches("==|!=|>=|<=|>|<")) {
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("kind", "compare");
                out.put("left", left);
                out.put("ops", Arrays.asList(op.operator));
                out.put("comparators", Arrays.asList(right));
                return out;
            }
            if (op.operator.equals("&&") || op.operator.equals("||")) {
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("kind", "bool_op");
                out.put("op", op.operator);
                out.put("values", Arrays.asList(left, right));
                return out;
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("kind", "binary_op");
            out.put("left", left);
            out.put("operator", op.operator);
            out.put("right", right);
            return out;
        }
        return map("kind", "constant", "value", expr);
    }

    private static Map<String, Object> map(Object... values) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < values.length; i += 2) {
            out.put(String.valueOf(values[i]), values[i + 1]);
        }
        return out;
    }

    private static String toStringValue(Object value) {
        if (value == null) {
            return "null";
        }
        if (value instanceof String) {
            return (String) value;
        }
        if (value instanceof Boolean) {
            return String.valueOf(value);
        }
        if (value instanceof Number) {
            return String.valueOf(value);
        }
        return String.valueOf(value);
    }

    private static boolean toBoolean(Object value) {
        if (value instanceof Boolean) {
            return (Boolean) value;
        }
        if (value instanceof Number) {
            return ((Number) value).doubleValue() != 0;
        }
        if (value instanceof String) {
            return !((String) value).isEmpty();
        }
        return value != null;
    }

    private static Object evaluateExpression(String exprText) {
        String expr = exprText.trim();
        if (expr.isEmpty()) {
            return null;
        }
        if ((expr.startsWith("\"") && expr.endsWith("\"")) || (expr.startsWith("'") && expr.endsWith("'"))) {
            return expr.substring(1, expr.length() - 1);
        }
        if (expr.matches("[-+]?\\d+")) {
            return Integer.parseInt(expr);
        }
        if (expr.matches("[-+]?\\d+\\.\\d+")) {
            return Double.parseDouble(expr);
        }
        if (expr.equalsIgnoreCase("true")) {
            return true;
        }
        if (expr.equalsIgnoreCase("false")) {
            return false;
        }
        if (expr.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            return variables.getOrDefault(expr, 0);
        }
        if (expr.startsWith("(") && expr.endsWith(")") && expr.length() >= 2) {
            return evaluateExpression(expr.substring(1, expr.length() - 1));
        }
        BinaryOp op = findBestOperator(expr);
        if (op == null) {
            return convertStringValue(expr);
        }
        Object left = evaluateExpression(op.left);
        Object right = evaluateExpression(op.right);
        switch (op.operator) {
            case "+":
                if (left instanceof String || right instanceof String) {
                    return toStringValue(left) + toStringValue(right);
                }
                return toNumber(left) + toNumber(right);
            case "-":
                return toNumber(left) - toNumber(right);
            case "*":
                return toNumber(left) * toNumber(right);
            case "/":
                return toNumber(left) / toNumber(right);
            case "%":
                return toNumber(left) % toNumber(right);
            case ">":
                return toNumber(left) > toNumber(right);
            case "<":
                return toNumber(left) < toNumber(right);
            case ">=":
                return toNumber(left) >= toNumber(right);
            case "<=":
                return toNumber(left) <= toNumber(right);
            case "==":
                return left == null ? right == null : left.equals(right);
            case "!=":
                return !(left == null ? right == null : left.equals(right));
            case "&&":
                return toBoolean(left) && toBoolean(right);
            case "||":
                return toBoolean(left) || toBoolean(right);
            default:
                return right;
        }
    }

    private static double toNumber(Object value) {
        if (value instanceof Number) {
            return ((Number) value).doubleValue();
        }
        if (value instanceof Boolean) {
            return ((Boolean) value) ? 1 : 0;
        }
        if (value instanceof String) {
            try {
                return Double.parseDouble((String) value);
            } catch (NumberFormatException ignored) {
                return 0;
            }
        }
        return 0;
    }

    private static void emitAssignment(String name, Object value, String rhs, int line) {
        if (rhs != null && !(rhs.matches("[-+]?\\d+")) && !rhs.matches("[-+]?\\d+\\.\\d+") && !rhs.matches("[A-Za-z_][A-Za-z0-9_]*") && !rhs.equalsIgnoreCase("true") && !rhs.equalsIgnoreCase("false")) {
            Map<String, Object> expr = expressionMap(rhs);
            Map<String, Object> exprEvent = new LinkedHashMap<>();
            exprEvent.put("expression", expr);
            exprEvent.put("operands", emptyMap());
            exprEvent.put("result", valueObject(value));
            addEvent("EXPRESSION_RESULT", line, exprEvent);
        }

        Map<String, Object> target = map("kind", "name", "name", name);
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("target", target);
        extra.put("value", valueObject(value));
        extra.put("rhs", rhs);
        addEvent("ASSIGNMENT", line, extra);
    }

    private static void emitCondition(String conditionText, boolean result, int line) {
        Map<String, Object> conditionExpr = expressionMap(conditionText);
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("condition", conditionExpr);
        extra.put("conditionText", conditionText);
        extra.put("result", result);
        extra.put("kind", "if");
        addEvent("CONDITION", line, extra);

        Map<String, Object> eval = new LinkedHashMap<>();
        eval.put("condition", conditionExpr);
        eval.put("conditionText", conditionText);
        eval.put("result", result);
        addEvent("CONDITION_EVALUATED", line, eval);
    }

    private static void emitOutput(String outputText, int line, Object value) {
        programOutput.append(outputText).append("\n");
        System.out.println(outputText);

        Map<String, Object> outputEvent = new LinkedHashMap<>();
        outputEvent.put("output", outputText);
        outputEvent.put("value", valueObject(value));
        addEvent("OUTPUT", line, outputEvent);

        Map<String, Object> expr = new LinkedHashMap<>();
        expr.put("kind", "call");
        Map<String, Object> fn = new LinkedHashMap<>();
        fn.put("kind", "name");
        fn.put("name", "print");
        expr.put("function", fn);
        List<Object> args = new ArrayList<>();
        if (value instanceof String) {
            args.add(expressionMap("\"" + value + "\""));
        } else {
            args.add(expressionMap(String.valueOf(value)));
        }
        expr.put("arguments", args);

        Map<String, Object> exprEvent = new LinkedHashMap<>();
        exprEvent.put("expression", expr);
        exprEvent.put("operands", emptyMap());
        exprEvent.put("result", valueObject(value));
        addEvent("EXPRESSION_RESULT", line, exprEvent);
    }

    private static void emitLoopIteration(String description, int line) {
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("loopType", "for");
        extra.put("description", description);
        extra.put("value", valueObject(variables.getOrDefault("i", 0)));
        addEvent("LOOP_ITERATION", line, extra);
    }

    private static int findMatchingBrace(List<String> lines, int startIndex) {
        int depth = 0;
        for (int i = startIndex; i < lines.size(); i++) {
            String line = lines.get(i);
            for (int j = 0; j < line.length(); j++) {
                char ch = line.charAt(j);
                if (ch == '{') depth += 1;
                if (ch == '}') {
                    depth -= 1;
                    if (depth == 0) {
                        return i;
                    }
                }
            }
        }
        return lines.size() - 1;
    }

    private static String stripTrailingSemicolon(String text) {
        String value = text.trim();
        if (value.endsWith(";")) {
            value = value.substring(0, value.length() - 1).trim();
        }
        return value;
    }

    private static void handleStatement(String statement, int lineNumber) {
        String trimmed = statement.trim();
        if (trimmed.isEmpty() || trimmed.startsWith("//") || trimmed.startsWith("public class") || trimmed.startsWith("class ") || trimmed.startsWith("import ") || trimmed.startsWith("package ")) {
            return;
        }
        if (trimmed.startsWith("if ")) {
            Pattern ifPattern = Pattern.compile("if\\s*\\((.*)\\)\\s*\\{");
            Matcher matcher = ifPattern.matcher(trimmed);
            if (matcher.find()) {
                String condition = matcher.group(1).trim();
                Object value = evaluateExpression(condition);
                boolean result = toBoolean(value);
                emitCondition(condition, result, lineNumber);
                return;
            }
        }
        if (trimmed.startsWith("for ")) {
            Pattern forPattern = Pattern.compile("for\\s*\\((.*)\\)\\s*\\{");
            Matcher matcher = forPattern.matcher(trimmed);
            if (matcher.find()) {
                String header = matcher.group(1).trim();
                String[] parts = header.split(";");
                if (parts.length == 3) {
                    String init = parts[0].trim();
                    String condition = parts[1].trim();
                    String update = parts[2].trim();
                    if (init.startsWith("int ")) {
                        String[] assign = init.split("=", 2);
                        String name = assign[0].replace("int", "").trim();
                        Object initValue = evaluateExpression(assign[1].trim());
                        setVariable(name, initValue);
                        emitAssignment(name, initValue, assign[1].trim(), lineNumber);
                    }
                    Object conditionValue = evaluateExpression(condition);
                    boolean checked = toBoolean(conditionValue);
                    emitCondition(condition, checked, lineNumber);
                    if (checked) {
                        emitLoopIteration("Loop iteration", lineNumber);
                    }
                    if (update.contains("++")) {
                        String name = update.replace("++", "").trim();
                        Object current = variables.getOrDefault(name, 0);
                        setVariable(name, toNumber(current) + 1);
                    }
                    return;
                }
            }
        }
        if (trimmed.startsWith("System.out.println")) {
            Pattern printPattern = Pattern.compile("System\\.out\\.println\\s*\\((.*)\\)");
            Matcher matcher = printPattern.matcher(trimmed);
            if (matcher.find()) {
                String arg = stripTrailingSemicolon(matcher.group(1).trim());
                Object value = evaluateExpression(arg);
                emitOutput(toStringValue(value), lineNumber, value);
                return;
            }
        }

        if (trimmed.matches("(?:int|long|double|boolean|String)\\s+[A-Za-z_][A-Za-z0-9_]*\\s*=.*")) {
            String withoutType = trimmed.replaceFirst("^(?:int|long|double|boolean|String)\\s+", "");
            String[] pieces = withoutType.split("=", 2);
            String name = pieces[0].trim();
            String rhs = stripTrailingSemicolon(pieces[1].trim());
            Object value = evaluateExpression(rhs);
            setVariable(name, value);
            emitAssignment(name, value, rhs, lineNumber);
            return;
        }

        if (trimmed.matches("[A-Za-z_][A-Za-z0-9_]*\\s*=.*")) {
            String[] pieces = trimmed.split("=", 2);
            String name = pieces[0].trim();
            String rhs = stripTrailingSemicolon(pieces[1].trim());
            Object value = evaluateExpression(rhs);
            setVariable(name, value);
            emitAssignment(name, value, rhs, lineNumber);
        }
    }

    private static void executeBlock(List<String> blockLines) {
        for (int i = 0; i < blockLines.size(); i++) {
            String line = blockLines.get(i).trim();
            if (line.isEmpty() || line.startsWith("//") || line.startsWith("}") || line.startsWith("else")) {
                continue;
            }
            int lineNumber = Integer.parseInt(blockLines.get(i).split(":", 2)[0]);
            String statement = blockLines.get(i).split(":", 2)[1].trim();
            handleStatement(statement, lineNumber);
        }
    }

    private static void executeProgram(String source) {
        String[] rawLines = source.split("\\r?\\n");
        List<String> lines = new ArrayList<>();
        for (int i = 0; i < rawLines.length; i++) {
            String cleaned = rawLines[i].trim();
            if (!cleaned.isEmpty()) {
                lines.add((i + 1) + ":" + cleaned);
            }
        }

        for (int i = 0; i < lines.size(); i++) {
            String entry = lines.get(i);
            String[] pieces = entry.split(":", 2);
            int lineNumber = Integer.parseInt(pieces[0]);
            String statement = pieces[1].trim();

            if (statement.startsWith("if ")) {
                Pattern ifPattern = Pattern.compile("if\\s*\\((.*)\\)\\s*\\{");
                Matcher matcher = ifPattern.matcher(statement);
                if (matcher.find()) {
                    String condition = matcher.group(1).trim();
                    Object value = evaluateExpression(condition);
                    boolean result = toBoolean(value);
                    emitCondition(condition, result, lineNumber);

                    int blockStart = i + 1;
                    int blockEnd = findMatchingBrace(lines, blockStart);
                    if (result) {
                        List<String> block = new ArrayList<>();
                        for (int j = blockStart; j < blockEnd; j++) {
                            if (j < lines.size()) {
                                block.add(lines.get(j));
                            }
                        }
                        executeBlock(block);
                    }

                    if (blockEnd < lines.size()) {
                        String nextLine = lines.get(blockEnd).split(":", 2)[1].trim();
                        if (nextLine.startsWith("else")) {
                            int elseStart = blockEnd + 1;
                            int elseEnd = findMatchingBrace(lines, elseStart);
                            if (!result) {
                                List<String> block = new ArrayList<>();
                                for (int j = elseStart; j < elseEnd; j++) {
                                    if (j < lines.size()) {
                                        block.add(lines.get(j));
                                    }
                                }
                                executeBlock(block);
                            }
                            i = elseEnd;
                        } else {
                            i = blockEnd;
                        }
                    } else {
                        i = blockEnd;
                    }
                    continue;
                }
            }

            if (statement.startsWith("for ")) {
                Pattern forPattern = Pattern.compile("for\\s*\\((.*)\\)\\s*\\{");
                Matcher matcher = forPattern.matcher(statement);
                if (matcher.find()) {
                    String header = matcher.group(1).trim();
                    String[] parts = header.split(";");
                    if (parts.length >= 3) {
                        String init = parts[0].trim();
                        String condition = parts[1].trim();
                        String update = parts[2].trim();
                        if (init.startsWith("int ")) {
                            String[] assign = init.split("=", 2);
                            String name = assign[0].replace("int", "").trim();
                            Object initValue = evaluateExpression(assign[1].trim());
                            setVariable(name, initValue);
                            emitAssignment(name, initValue, assign[1].trim(), lineNumber);
                        }

                        int blockStart = i + 1;
                        int blockEnd = findMatchingBrace(lines, blockStart);
                        int loopCounter = 0;
                        while (toBoolean(evaluateExpression(condition))) {
                            loopCounter += 1;
                            if (loopCounter > 20) break;
                            emitLoopIteration("for loop iteration", lineNumber);
                            List<String> block = new ArrayList<>();
                            for (int j = blockStart; j < blockEnd; j++) {
                                if (j < lines.size()) {
                                    block.add(lines.get(j));
                                }
                            }
                            executeBlock(block);

                            if (update.contains("++")) {
                                String name = update.replace("++", "").trim();
                                Object current = variables.getOrDefault(name, 0);
                                setVariable(name, toNumber(current) + 1);
                            }
                            if (condition.contains("<=") || condition.contains("<") || condition.contains(">=") || condition.contains(">")) {
                                // condition is re-evaluated naturally by while loop.
                            }
                        }
                        i = blockEnd;
                        continue;
                    }
                }
            }

            handleStatement(statement, lineNumber);
        }
    }

    private static String escapeJson(String text) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            switch (ch) {
                case '\\': out.append("\\\\"); break;
                case '"': out.append("\\\""); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (ch < 0x20) {
                        out.append(String.format("\\u%04x", (int) ch));
                    } else {
                        out.append(ch);
                    }
            }
        }
        return out.toString();
    }

    private static String jsonValue(Object value) {
        if (value == null) return "null";
        if (value instanceof Number || value instanceof Boolean) return String.valueOf(value);
        if (value instanceof String) return "\"" + escapeJson((String) value) + "\"";
        if (value instanceof Map<?, ?>) {
            StringBuilder out = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (!first) out.append(",");
                first = false;
                out.append("\"").append(escapeJson(String.valueOf(entry.getKey()))).append("\":").append(jsonValue(entry.getValue()));
            }
            out.append("}");
            return out.toString();
        }
        if (value instanceof List<?>) {
            StringBuilder out = new StringBuilder("[");
            for (int i = 0; i < ((List<?>) value).size(); i++) {
                if (i > 0) out.append(",");
                out.append(jsonValue(((List<?>) value).get(i)));
            }
            out.append("]");
            return out.toString();
        }
        return "\"" + escapeJson(String.valueOf(value)) + "\"";
    }

    private static String jsonResult(Map<String, Object> response) {
        return jsonValue(response);
    }

    private static void failAndExit(String message) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("success", false);
        response.put("events", emptyList());
        response.put("semanticSteps", emptyList());
        response.put("aiExplanations", emptyList());
        response.put("objects", emptyMap());
        response.put("references", emptyMap());
        response.put("output", "");
        response.put("error", message);
        System.out.println(jsonResult(response));
        System.exit(1);
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            failAndExit("No Java source file provided.");
        }

        Path sourcePath = Paths.get(args[0]);
        if (!Files.exists(sourcePath)) {
            failAndExit("Java source file does not exist.");
        }

        String source = Files.readString(sourcePath, StandardCharsets.UTF_8);
        PrintStream originalOut = System.out;
        ByteArrayOutputStream capturedOut = new ByteArrayOutputStream();
        System.setOut(new PrintStream(capturedOut, true, StandardCharsets.UTF_8.name()));

        addEvent("FUNCTION_ENTER", 1, map("function", "<module>", "arguments", emptyMap()));

        try {
            executeProgram(source);
        } catch (Exception ex) {
            System.setOut(originalOut);
            failAndExit(ex.getMessage());
        }

        addEvent("FUNCTION_EXIT", lastLine, map("function", "<module>", "returnValue", null));

        String captured = capturedOut.toString(StandardCharsets.UTF_8.name());
        String outputValue = captured.replace("\r\n", "\n").replace("\r", "\n");
        if (outputValue.endsWith("\n")) {
            outputValue = outputValue.substring(0, outputValue.length() - 1);
        }

        System.setOut(originalOut);

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("success", true);
        response.put("events", events);
        response.put("semanticSteps", emptyList());
        response.put("aiExplanations", emptyList());
        response.put("objects", emptyMap());
        response.put("references", emptyMap());
        response.put("output", outputValue);
        response.put("error", null);

        System.out.println(jsonResult(response));
    }

    static class BinaryOp {
        final String operator;
        final String left;
        final String right;

        BinaryOp(String operator, String left, String right) {
            this.operator = operator;
            this.left = left;
            this.right = right;
        }
    }
}
