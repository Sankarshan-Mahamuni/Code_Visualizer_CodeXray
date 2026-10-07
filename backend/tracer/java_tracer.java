import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

class JavaTracer {
    private static final List<Map<String, Object>> events = new ArrayList<>();
    private static final Map<String, Object> variables = new LinkedHashMap<>();
    private static final Map<String, MethodDefinition> methods = new LinkedHashMap<>();
    private static final List<TraceFrame> frames = new ArrayList<>();
    private static final IdentityHashMap<Object, String> objectIds = new IdentityHashMap<>();
    private static final Map<String, Object> objectRegistry = new LinkedHashMap<>();
    private static List<String> currentProgramLines = new ArrayList<>();
    private static final StringBuilder programOutput = new StringBuilder();
    private static final String moduleName = "<module>";
    private static final String moduleFrameId = "f1";
    private static int step = 0;
    private static int lastLine = 1;
    private static int nextFrameId = 1;
    private static int activeLine = 1;

    private static Map<String, Object> emptyMap() {
        return new LinkedHashMap<>();
    }

    private static List<Object> emptyList() {
        return new ArrayList<>();
    }

    private static List<Object> callStack() {
        List<Object> stack = new ArrayList<>();
        if (frames.isEmpty()) {
            stack.add(map("frameId", moduleFrameId, "parentFrameId", null, "function", moduleName, "arguments", emptyMap()));
            return stack;
        }
        for (TraceFrame frame : frames) {
            stack.add(map("frameId", frame.frameId, "parentFrameId", frame.parentFrameId, "function", frame.function, "arguments", frame.arguments));
        }
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
        if (value instanceof List<?>) {
            out.put("type", value instanceof TrackedArray ? "array" : "list");
            out.put("objectId", registerObject((List<?>) value));
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
        if (frames.size() > 1) {
            for (Map.Entry<String, Object> entry : frames.get(frames.size() - 1).locals.entrySet()) {
                snapshot.put(entry.getKey(), valueObject(entry.getValue()));
            }
        }
        return snapshot;
    }

    private static String registerObject(List<?> value) {
        String objectId = objectIds.get(value);
        if (objectId == null) {
            objectId = "obj_" + (objectIds.size() + 1);
            objectIds.put(value, objectId);
            objectRegistry.put(objectId, map("type", value instanceof TrackedArray ? "array" : "list", "fields", emptyMap()));
        }
        Map<String, Object> fields = new LinkedHashMap<>();
        for (int i = 0; i < value.size(); i++) {
            fields.put(String.valueOf(i), valueObject(value.get(i)));
        }
        objectRegistry.put(objectId, map("type", value instanceof TrackedArray ? "array" : "list", "fields", fields));
        return objectId;
    }

    private static Map<String, Object> referencesSnapshot() {
        Map<String, Object> references = new LinkedHashMap<>();
        Map<String, Object> visible = frames.size() > 1 ? frames.get(frames.size() - 1).locals : variables;
        for (Map.Entry<String, Object> entry : visible.entrySet()) {
            if (entry.getValue() instanceof List<?>) references.put(entry.getKey(), registerObject((List<?>) entry.getValue()));
        }
        return references;
    }

    private static Object copySnapshot(Object value) {
        if (value instanceof Map<?, ?>) {
            Map<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                copy.put(String.valueOf(entry.getKey()), copySnapshot(entry.getValue()));
            }
            return copy;
        }
        if (value instanceof List<?>) {
            List<Object> copy = new ArrayList<>();
            for (Object item : (List<?>) value) copy.add(copySnapshot(item));
            return copy;
        }
        return value;
    }

    private static void addEvent(String eventType, int line, Map<String, Object> extra) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("step", step);
        event.put("line", line);
        event.put("event", eventType);
        TraceFrame frame = frames.isEmpty() ? null : frames.get(frames.size() - 1);
        event.put("function", frame == null ? moduleName : frame.function);
        event.put("frameId", frame == null ? moduleFrameId : frame.frameId);
        event.put("variables", variableSnapshot());
        event.put("references", referencesSnapshot());
        event.put("objects", copySnapshot(objectRegistry));
        event.put("callStack", callStack());
        if (extra != null) {
            event.putAll(extra);
        }
        events.add(event);
        step += 1;
        lastLine = Math.max(lastLine, line);
    }

    private static void setVariable(String name, Object value) {
        if (frames.size() > 1) {
            frames.get(frames.size() - 1).locals.put(name, value);
        } else {
            variables.put(name, value);
        }
    }

    private static Object getVariable(String name) {
        for (int i = frames.size() - 1; i > 0; i--) {
            if (frames.get(i).locals.containsKey(name)) return frames.get(i).locals.get(name);
        }
        return variables.getOrDefault(name, 0);
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
        Matcher subscript = Pattern.compile("([A-Za-z_][A-Za-z0-9_]*)\\s*\\[(.*)\\]").matcher(expr);
        if (subscript.matches()) {
            return map("kind", "subscript", "value", expressionMap(subscript.group(1)), "slice", expressionMap(subscript.group(2)));
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
        Matcher arrayInitializer = Pattern.compile("(?:new\\s+[A-Za-z_][A-Za-z0-9_]*\\s*\\[\\s*\\]\\s*)?\\{(.*)\\}").matcher(expr);
        if (arrayInitializer.matches()) {
            TrackedArray values = new TrackedArray();
            for (String item : splitArguments(arrayInitializer.group(1))) {
                if (!item.trim().isEmpty()) values.add(evaluateExpression(item));
            }
            return values;
        }
        Matcher arrayAllocation = Pattern.compile("new\\s+(int|long|double|float|boolean|char|String)\\s*\\[\\s*(.*?)\\s*\\]").matcher(expr);
        if (arrayAllocation.matches()) {
            int length = ((Number) evaluateExpression(arrayAllocation.group(2))).intValue();
            if (length < 0 || length > 10000) throw new IllegalArgumentException("Array size must be between 0 and 10000.");
            Object initialValue = arrayAllocation.group(1).equals("boolean") ? false : arrayAllocation.group(1).equals("String") ? null : 0;
            TrackedArray values = new TrackedArray();
            for (int i = 0; i < length; i++) values.add(initialValue);
            return values;
        }
        Matcher callMatcher = Pattern.compile("([A-Za-z_][A-Za-z0-9_]*)\\s*\\((.*)\\)").matcher(expr);
        if (callMatcher.matches() && methods.containsKey(callMatcher.group(1))) {
            List<Object> arguments = new ArrayList<>();
            for (String argument : splitArguments(callMatcher.group(2))) {
                if (!argument.trim().isEmpty()) arguments.add(evaluateExpression(argument));
            }
            return invokeMethod(callMatcher.group(1), arguments, activeLine);
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
            return getVariable(expr);
        }
        if (expr.startsWith("(") && expr.endsWith(")") && expr.length() >= 2) {
            return evaluateExpression(expr.substring(1, expr.length() - 1));
        }
        Matcher subscriptMatcher = Pattern.compile("([A-Za-z_][A-Za-z0-9_]*)\\s*\\[(.*)\\]").matcher(expr);
        if (subscriptMatcher.matches()) {
            Object container = getVariable(subscriptMatcher.group(1));
            Object indexValue = evaluateExpression(subscriptMatcher.group(2));
            if (container instanceof List<?> && indexValue instanceof Number) {
                List<?> values = (List<?>) container;
                int index = ((Number) indexValue).intValue();
                Object value = values.get(index);
                addEvent("MEMORY_READ", activeLine, map("containerType", "array", "key", valueObject(index), "value", valueObject(value)));
                return value;
            }
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
                return arithmeticResult("+", left, right);
            case "-":
                return arithmeticResult("-", left, right);
            case "*":
                return arithmeticResult("*", left, right);
            case "/":
                return arithmeticResult("/", left, right);
            case "%":
                return arithmeticResult("%", left, right);
            case ">":
                return toNumber(left) > toNumber(right);
            case "<":
                return toNumber(left) < toNumber(right);
            case ">=":
                return toNumber(left) >= toNumber(right);
            case "<=":
                return toNumber(left) <= toNumber(right);
            case "==":
                if (left instanceof Number && right instanceof Number) {
                    return toNumber(left) == toNumber(right);
                }
                return left == null ? right == null : left.equals(right);
            case "!=":
                if (left instanceof Number && right instanceof Number) {
                    return toNumber(left) != toNumber(right);
                }
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

    private static boolean isIntegralNumber(Object value) {
        return value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long;
    }

    private static Object arithmeticResult(String operator, Object left, Object right) {
        double leftNumber = toNumber(left);
        double rightNumber = toNumber(right);
        double result;
        switch (operator) {
            case "+": result = leftNumber + rightNumber; break;
            case "-": result = leftNumber - rightNumber; break;
            case "*": result = leftNumber * rightNumber; break;
            case "/": result = leftNumber / rightNumber; break;
            case "%": result = leftNumber % rightNumber; break;
            default: return right;
        }
        if (isIntegralNumber(left) && isIntegralNumber(right)) {
            return (int) result;
        }
        return result;
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
            String text = lineText(lines.get(i));
            if (text.equals("{")) {
                depth += 1;
            } else if (text.equals("}")) {
                depth -= 1;
                if (depth == 0) {
                    return i;
                }
            }
        }
        return lines.size() - 1;
    }

    private static int lineNumber(String entry) {
        return Integer.parseInt(entry.substring(0, entry.indexOf(':')));
    }

    private static String lineText(String entry) {
        return entry.substring(entry.indexOf(':') + 1).trim();
    }

    private static List<String> tokenizeSource(String source) {
        List<String> tokens = new ArrayList<>();
        String[] sourceLines = source.split("\\r?\\n", -1);
        int initializerDepth = 0;
        for (int lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
            String text = sourceLines[lineIndex];
            StringBuilder current = new StringBuilder();
            boolean inSingle = false;
            boolean inDouble = false;
            boolean escaped = false;

            for (int i = 0; i < text.length(); i++) {
                char ch = text.charAt(i);
                if (!inSingle && !inDouble && ch == '/' && i + 1 < text.length() && text.charAt(i + 1) == '/') {
                    break;
                }
                if (escaped) {
                    current.append(ch);
                    escaped = false;
                    continue;
                }
                if ((inSingle || inDouble) && ch == '\\') {
                    current.append(ch);
                    escaped = true;
                    continue;
                }
                if (ch == '\'' && !inDouble) inSingle = !inSingle;
                if (ch == '"' && !inSingle) inDouble = !inDouble;

                if (!inSingle && !inDouble && ch == '{' && (initializerDepth > 0 || isArrayInitializerStart(current.toString()))) {
                    initializerDepth += 1;
                    current.append(ch);
                    continue;
                }
                if (!inSingle && !inDouble && ch == '}' && initializerDepth > 0) {
                    initializerDepth -= 1;
                    current.append(ch);
                    continue;
                }
                if (!inSingle && !inDouble && (ch == '{' || ch == '}')) {
                    addToken(tokens, lineIndex + 1, current.toString());
                    current.setLength(0);
                    tokens.add((lineIndex + 1) + ":" + ch);
                } else {
                    current.append(ch);
                }
            }
            addToken(tokens, lineIndex + 1, current.toString());
        }
        return tokens;
    }

    private static boolean isArrayInitializerStart(String text) {
        String trimmed = text.trim();
        return trimmed.endsWith("=") || trimmed.matches(".*new\\s+[A-Za-z_][A-Za-z0-9_]*\\s*\\[\\s*\\]\\s*");
    }

    private static void addToken(List<String> tokens, int line, String text) {
        String trimmed = text.trim();
        if (!trimmed.isEmpty()) {
            tokens.add(line + ":" + trimmed);
        }
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

        Matcher arrayWrite = Pattern.compile("([A-Za-z_][A-Za-z0-9_]*)\\s*\\[(.*)\\]\\s*=\\s*(.*)").matcher(stripTrailingSemicolon(trimmed));
        if (arrayWrite.matches()) {
            Object container = getVariable(arrayWrite.group(1));
            int index = ((Number) evaluateExpression(arrayWrite.group(2))).intValue();
            Object value = evaluateExpression(arrayWrite.group(3));
            if (container instanceof List<?>) {
                ((TrackedArray) container).set(index, value);
                addEvent("MEMORY_WRITE", lineNumber, map("containerType", "array", "key", valueObject(index), "value", valueObject(value)));
            }
            return;
        }

        String withoutSemicolon = stripTrailingSemicolon(trimmed);
        Matcher incrementMatcher = Pattern.compile("(?:\\+\\+|--)?\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*(\\+\\+|--)").matcher(withoutSemicolon);
        if (incrementMatcher.matches()) {
            String name = incrementMatcher.group(1);
            String operator = incrementMatcher.group(2);
            Object oldValue = getVariable(name);
            Object newValue = arithmeticResult(operator.equals("++") ? "+" : "-", oldValue, 1);
            setVariable(name, newValue);
            addEvent("AUG_ASSIGNMENT", lineNumber, map("target", map("kind", "name", "name", name), "operator", operator, "oldValue", valueObject(oldValue), "value", valueObject(newValue)));
            return;
        }

        Matcher augMatcher = Pattern.compile("([A-Za-z_][A-Za-z0-9_]*)\\s*(\\+=|-=|\\*=|/=|%=)\\s*(.*)").matcher(withoutSemicolon);
        if (augMatcher.matches()) {
            String name = augMatcher.group(1);
            String operator = augMatcher.group(2);
            String rhs = augMatcher.group(3).trim();
            Object oldValue = getVariable(name);
            Object rhsValue = evaluateExpression(rhs);
            Object newValue = arithmeticResult(operator.substring(0, 1), oldValue, rhsValue);
            setVariable(name, newValue);
            addEvent("AUG_ASSIGNMENT", lineNumber, map("target", map("kind", "name", "name", name), "operator", operator, "oldValue", valueObject(oldValue), "value", valueObject(newValue), "rhs", rhs));
            return;
        }

        if (trimmed.matches("(?:int|long|double|float|boolean|char|String)(?:\\s*\\[\\s*\\])?\\s+[A-Za-z_][A-Za-z0-9_]*\\s*=.*")) {
            String withoutType = trimmed.replaceFirst("^(?:int|long|double|float|boolean|char|String)(?:\\s*\\[\\s*\\])?\\s+", "");
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

    private enum Flow { NORMAL, BREAK, CONTINUE, RETURN }

    private static Flow executeRange(List<String> lines, int start, int end) {
        int index = start;
        while (index < end) {
            String entry = lines.get(index);
            String statement = lineText(entry);
            int line = lineNumber(entry);
            activeLine = line;

            if (statement.equals("}")) return Flow.NORMAL;
            if (statement.isEmpty()) {
                index += 1;
                continue;
            }
            if (statement.equals("{")) {
                int close = findMatchingBrace(lines, index);
                Flow flow = executeRange(lines, index + 1, close);
                if (flow != Flow.NORMAL) return flow;
                index = close + 1;
                continue;
            }

            Matcher ifMatcher = Pattern.compile("if\\s*\\((.*)\\)").matcher(statement);
            if (ifMatcher.matches()) {
                String condition = ifMatcher.group(1).trim();
                boolean selected = evaluateCondition(condition, line, "if");
                int open = index + 1;
                int close = findMatchingBrace(lines, open);
                if (selected) {
                    Flow flow = executeRange(lines, open + 1, close);
                    if (flow != Flow.NORMAL) return flow;
                }
                index = close + 1;

                while (index < end && lineText(lines.get(index)).startsWith("else")) {
                    String elseText = lineText(lines.get(index));
                    if (elseText.startsWith("else if")) {
                        Matcher elseIf = Pattern.compile("else\\s+if\\s*\\((.*)\\)").matcher(elseText);
                        if (!elseIf.matches()) break;
                        String elseCondition = elseIf.group(1).trim();
                        boolean elseSelected = !selected && evaluateCondition(elseCondition, lineNumber(lines.get(index)), "if");
                        int elseOpen = index + 1;
                        int elseClose = findMatchingBrace(lines, elseOpen);
                        if (elseSelected) {
                            Flow flow = executeRange(lines, elseOpen + 1, elseClose);
                            if (flow != Flow.NORMAL) return flow;
                            selected = true;
                        }
                        index = elseClose + 1;
                    } else {
                        int elseOpen = index + 1;
                        int elseClose = findMatchingBrace(lines, elseOpen);
                        if (!selected) {
                            Flow flow = executeRange(lines, elseOpen + 1, elseClose);
                            if (flow != Flow.NORMAL) return flow;
                        }
                        index = elseClose + 1;
                        break;
                    }
                }
                continue;
            }

            Matcher whileMatcher = Pattern.compile("while\\s*\\((.*)\\)").matcher(statement);
            if (whileMatcher.matches()) {
                String condition = whileMatcher.group(1).trim();
                int open = index + 1;
                int close = findMatchingBrace(lines, open);
                int iterations = 0;
                while (evaluateCondition(condition, line, "while")) {
                    if (++iterations > 10000) throw new IllegalStateException("Loop exceeded 10000 iterations.");
                    emitLoopIteration("while", null, null, line, condition);
                    Flow flow = executeRange(lines, open + 1, close);
                    if (flow == Flow.BREAK) break;
                    if (flow == Flow.RETURN) return flow;
                }
                index = close + 1;
                continue;
            }

            Matcher forMatcher = Pattern.compile("for\\s*\\((.*)\\)").matcher(statement);
            if (forMatcher.matches()) {
                String[] parts = forMatcher.group(1).split(";", 3);
                if (parts.length == 3) {
                    String init = parts[0].trim();
                    String condition = parts[1].trim();
                    String update = parts[2].trim();
                    if (!init.isEmpty()) {
                        handleStatement(init, line);
                    }
                    int open = index + 1;
                    int close = findMatchingBrace(lines, open);
                    String targetName = loopTargetName(init);
                    int iterations = 0;
                    while (evaluateCondition(condition, line, "for")) {
                        if (++iterations > 10000) throw new IllegalStateException("Loop exceeded 10000 iterations.");
                        emitLoopIteration("for", targetName, targetName == null ? null : getVariable(targetName), line, condition);
                        Flow flow = executeRange(lines, open + 1, close);
                        if (flow == Flow.BREAK) break;
                        if (flow == Flow.RETURN) return flow;
                        applyLoopUpdate(update, line);
                    }
                    index = close + 1;
                    continue;
                }
            }

            if (statement.equals("break;") || statement.equals("break")) {
                addEvent("BREAK", line, map("description", "break"));
                return Flow.BREAK;
            }
            if (statement.equals("continue;") || statement.equals("continue")) {
                addEvent("CONTINUE", line, map("description", "continue"));
                return Flow.CONTINUE;
            }

            if (statement.startsWith("return") && frames.size() > 1) {
                addEvent("LINE_EXECUTED", line, null);
                String expression = stripTrailingSemicolon(statement.substring("return".length()).trim());
                TraceFrame frame = frames.get(frames.size() - 1);
                frame.returnValue = expression.isEmpty() ? null : evaluateExpression(expression);
                addEvent("FUNCTION_EXIT", line, map("returnValue", valueObject(frame.returnValue)));
                return Flow.RETURN;
            }

            if (statement.equals("{")) {
                index += 1;
                continue;
            }
            if (statement.startsWith("public class") || statement.startsWith("class ") || statement.startsWith("import ") || statement.startsWith("package ") || statement.matches("(?:public|private|protected)?\\s*(?:static\\s+)?(?:void|int|long|double|boolean|String)\\s+[A-Za-z_][A-Za-z0-9_]*\\s*\\(.*")) {
                index += 1;
                continue;
            }

            addEvent("LINE_EXECUTED", line, null);
            handleStatement(statement, line);
            index += 1;
        }
        return Flow.NORMAL;
    }

    private static boolean evaluateCondition(String condition, int line, String kind) {
        addEvent("LINE_EXECUTED", line, null);
        boolean result = toBoolean(evaluateExpression(condition));
        Map<String, Object> conditionExpr = expressionMap(condition);
        Map<String, Object> extra = map("condition", conditionExpr, "conditionText", condition, "result", result, "kind", kind);
        addEvent("CONDITION", line, extra);
        addEvent("CONDITION_EVALUATED", line, map("condition", conditionExpr, "conditionText", condition, "result", result));
        return result;
    }

    private static String loopTargetName(String init) {
        Matcher matcher = Pattern.compile("(?:int|long|double|boolean|String)?\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=.*").matcher(init.trim());
        return matcher.matches() ? matcher.group(1) : null;
    }

    private static void applyLoopUpdate(String update, int line) {
        String text = update.trim();
        Matcher matcher = Pattern.compile("([A-Za-z_][A-Za-z0-9_]*)\\s*(\\+\\+|--|\\+=|-=)\\s*(.*)").matcher(text);
        if (!matcher.matches()) return;
        String name = matcher.group(1);
        String operator = matcher.group(2);
        Object oldValue = getVariable(name);
        Object newValue;
        if (operator.equals("++")) newValue = arithmeticResult("+", oldValue, 1);
        else if (operator.equals("--")) newValue = arithmeticResult("-", oldValue, 1);
        else {
            Object amount = evaluateExpression(matcher.group(3));
            newValue = arithmeticResult(operator.equals("+=") ? "+" : "-", oldValue, amount);
        }
        setVariable(name, newValue);
        Map<String, Object> extra = map("target", map("kind", "name", "name", name), "operator", operator, "oldValue", valueObject(oldValue), "value", valueObject(newValue), "rhs", matcher.group(3));
        addEvent("AUG_ASSIGNMENT", line, extra);
    }

    private static void emitLoopIteration(String loopType, String targetName, Object value, int line, String description) {
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("loopType", loopType);
        if (targetName != null) extra.put("target", map("kind", "name", "name", targetName));
        extra.put("description", description);
        extra.put("value", value == null ? null : valueObject(value));
        addEvent("LOOP_ITERATION", line, extra);
    }

    private static List<String> splitArguments(String text) {
        List<String> arguments = new ArrayList<>();
        int depth = 0;
        boolean inSingle = false;
        boolean inDouble = false;
        int start = 0;
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (ch == '\'' && !inDouble) inSingle = !inSingle;
            else if (ch == '"' && !inSingle) inDouble = !inDouble;
            else if (!inSingle && !inDouble) {
                if (ch == '(' || ch == '[' || ch == '{') depth += 1;
                else if (ch == ')' || ch == ']' || ch == '}') depth -= 1;
                else if (ch == ',' && depth == 0) {
                    arguments.add(text.substring(start, i).trim());
                    start = i + 1;
                }
            }
        }
        if (start < text.length() || !text.trim().isEmpty()) arguments.add(text.substring(start).trim());
        return arguments;
    }

    private static void collectMethods(List<String> lines) {
        Pattern methodPattern = Pattern.compile("(?:(?:public|private|protected)\\s+)?(?:static\\s+)?(?:final\\s+)?(?:void|int|long|double|float|boolean|char|String)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\((.*)\\)");
        Pattern parameterPattern = Pattern.compile("(?:final\\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\\s*\\[\\s*\\])*\\s+([A-Za-z_$][A-Za-z0-9_$]*)");
        for (int i = 0; i + 1 < lines.size(); i++) {
            Matcher matcher = methodPattern.matcher(lineText(lines.get(i)));
            if (!matcher.matches() || !lineText(lines.get(i + 1)).equals("{")) continue;
            List<String> parameters = new ArrayList<>();
            for (String parameter : splitArguments(matcher.group(2))) {
                Matcher param = parameterPattern.matcher(parameter.trim());
                if (param.matches()) parameters.add(param.group(1));
            }
            int close = findMatchingBrace(lines, i + 1);
            methods.put(matcher.group(1), new MethodDefinition(matcher.group(1), parameters, lineNumber(lines.get(i)), i + 2, close));
        }
    }

    private static Object invokeMethod(String name, List<Object> values, int callLine) {
        MethodDefinition method = methods.get(name);
        if (method == null) return null;
        Map<String, Object> locals = new LinkedHashMap<>();
        Map<String, Object> arguments = new LinkedHashMap<>();
        for (int i = 0; i < method.parameters.size(); i++) {
            Object value = i < values.size() ? values.get(i) : null;
            String parameter = method.parameters.get(i);
            locals.put(parameter, value);
            arguments.put(parameter, valueObject(value));
        }
        String parentId = frames.isEmpty() ? null : frames.get(frames.size() - 1).frameId;
        String frameId = "f" + (++nextFrameId);
        TraceFrame frame = new TraceFrame(frameId, parentId, name, locals, arguments);
        frames.add(frame);
        addEvent("FUNCTION_ENTER", callLine, map("arguments", arguments));
        Flow flow = executeRange(currentProgramLines, method.bodyStart, method.bodyEnd);
        if (flow != Flow.RETURN) {
            addEvent("FUNCTION_EXIT", method.bodyEnd == 0 ? method.line : lineNumber(currentProgramLines.get(method.bodyEnd - 1)), map("returnValue", valueObject(null)));
        }
        frames.remove(frames.size() - 1);
        return frame.returnValue;
    }

    private static void executeProgram(String source) {
        currentProgramLines = tokenizeSource(source);
        collectMethods(currentProgramLines);
        if (methods.containsKey("main")) {
            TrackedArray mainArguments = new TrackedArray();
            invokeMethod("main", Arrays.<Object>asList(mainArguments), methods.get("main").line);
        } else {
            executeRange(currentProgramLines, 0, currentProgramLines.size());
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

        frames.add(new TraceFrame(moduleFrameId, null, moduleName, variables, emptyMap()));
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
        response.put("objects", copySnapshot(objectRegistry));
        response.put("references", events.isEmpty() ? emptyMap() : events.get(events.size() - 1).get("references"));
        response.put("output", outputValue);
        response.put("error", null);

        System.out.println(jsonResult(response));
    }

    static class TrackedArray extends ArrayList<Object> {
        private static final long serialVersionUID = 1L;
    }

    static class TraceFrame {
        final String frameId;
        final String parentFrameId;
        final String function;
        final Map<String, Object> locals;
        final Map<String, Object> arguments;
        Object returnValue;

        TraceFrame(String frameId, String parentFrameId, String function, Map<String, Object> locals, Map<String, Object> arguments) {
            this.frameId = frameId;
            this.parentFrameId = parentFrameId;
            this.function = function;
            this.locals = locals;
            this.arguments = arguments;
        }
    }

    static class MethodDefinition {
        final String name;
        final List<String> parameters;
        final int line;
        final int bodyStart;
        final int bodyEnd;

        MethodDefinition(String name, List<String> parameters, int line, int bodyStart, int bodyEnd) {
            this.name = name;
            this.parameters = parameters;
            this.line = line;
            this.bodyStart = bodyStart;
            this.bodyEnd = bodyEnd;
        }
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
